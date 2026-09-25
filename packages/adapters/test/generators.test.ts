import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateClaudePlugin } from "../src/claude-plugin.ts";
import { installCodexConfig, renderCodexConfig, renderCodexOverrides } from "../src/codex-config.ts";
import { endSession, lastAssistantText, observe, observeBody, registerSession, REPLY_LIMIT } from "../src/hook.ts";

const options = { shimPath: "/tmp/shim.ts", nodePath: process.execPath };
const root = mkdtempSync(join(tmpdir(), "agent-graph-adapters-"));

test("Codex の生成設定は実行時のソケットと親文脈を転送し、上書き時のみ MCP 起動を必須にする", () => {
  const config = renderCodexConfig(options);
  const overrides = renderCodexOverrides(options);
  assert.equal(overrides[0], "-c");
  assert.ok(overrides[1].startsWith("mcp_servers.agent-graph={command="));
  for (const output of [config, overrides[1]]) {
    const forwarded = JSON.parse(output.match(/env_vars\s*=\s*(\[[^\]]*\])/)![1]);
    assert.deepEqual(forwarded, ["AGENT_GRAPH_SOCKET", "XDG_STATE_HOME", "TRACEPARENT", "TRACESTATE", "AGENT_GRAPH_SESSION"]);
  }
  assert.doesNotMatch(config, /\brequired\s*=/);
  assert.match(overrides[1], /required\s*=\s*true/);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const printed = spawnSync(process.execPath, [cli, "--print-codex-overrides"], { encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(printed.stdout.trimEnd().split("\n"), renderCodexOverrides({
    nodePath: process.execPath,
    shimPath: fileURLToPath(new URL("../../daemon/src/shim.ts", import.meta.url)),
  }));
});

test("Claude plugin の JSON と hook", () => {
  const outDir = join(root, "plugin");
  generateClaudePlugin({ outDir, hookPath: "/tmp/agent graph/hook.ts", ...options });
  const manifest = JSON.parse(readFileSync(join(outDir, ".claude-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(outDir, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(outDir, "hooks/hooks.json"), "utf8"));
  const settings = JSON.parse(readFileSync(join(outDir, "recommended-settings.json"), "utf8"));
  assert.equal(manifest.name, "agent-graph");
  assert.deepEqual(mcp.mcpServers["agent-graph"], { command: process.execPath, args: [options.shimPath], env: { AGENT_GRAPH_CLIENT: "claude" } });
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "Notification"]);
  const command = (args: string) => `${JSON.stringify(process.execPath)} ${JSON.stringify("/tmp/agent graph/hook.ts")} ${args}`;
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, command("session-start"));
  assert.equal(hooks.hooks.SessionEnd[0].hooks[0].command, command("session-end"));
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, command("observe turn_start"));
  assert.equal(hooks.hooks.Stop[0].hooks[0].command, command("observe turn_done"));
  assert.equal(hooks.hooks.Notification[0].hooks[0].command, command("observe notification"));
  for (const event of Object.keys(hooks.hooks)) assert.equal(hooks.hooks[event][0].hooks[0].timeout, 5);
  assert.ok(settings.permissions.deny.length);
});

test("Codex 設定の追記、置換、バックアップ", () => {
  const configPath = join(root, "config.toml");
  const original = "model = \"example\"\n[other]\nvalue = 1 # keep\n";
  writeFileSync(configPath, original);
  installCodexConfig({ configPath, ...options });
  const first = readFileSync(configPath, "utf8");
  assert.ok(first.startsWith(original));
  assert.match(first, /\[mcp_servers\.agent-graph\]/);
  assert.match(first, /approval_mode = "approve"/);
  assert.equal(readFileSync(`${configPath}.agent-graph.bak`, "utf8"), original);
  installCodexConfig({ configPath, shimPath: "/tmp/next.ts", nodePath: process.execPath });
  const second = readFileSync(configPath, "utf8");
  assert.equal(second.match(/\[mcp_servers\.agent-graph\]/g)?.length, 1);
  assert.match(second, /next\.ts/);
  assert.ok(second.startsWith(original));
  assert.equal(readFileSync(`${configPath}.agent-graph.bak`, "utf8"), first);
  assert.ok(renderCodexOverrides(options).includes('mcp_servers.agent-graph.tools.delegate.approval_mode="approve"'));
  const trailing = "[other2]\nvalue = 2 # keep exactly\n";
  writeFileSync(configPath, `${second}${trailing}`);
  installCodexConfig({ configPath, shimPath: "/tmp/next.ts", nodePath: process.execPath });
  assert.equal(readFileSync(configPath, "utf8"), `${second}${trailing}`);
  assert.equal(readFileSync(`${configPath}.agent-graph.bak`, "utf8"), `${second}${trailing}`);
});

test("hook はどの経路でも到達不能や不正な入力で 0 で終わる", () => {
  const hook = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
  const env = { ...process.env, AGENT_GRAPH_PORT: "1" };
  const inputs: [string[], string][] = [
    [["session-start"], JSON.stringify({ session_id: "s1", cwd: root })],
    [["session-end"], JSON.stringify({ session_id: "s1", reason: "exit" })],
    [["observe", "turn_start"], JSON.stringify({ session_id: "s1", prompt: "hi" })],
    [["observe", "turn_done"], JSON.stringify({ session_id: "s1", last_assistant_message: "done" })],
    [["observe", "notification"], JSON.stringify({ session_id: "s1", notification_type: "permission_prompt" })],
    [["observe", "unknown"], JSON.stringify({ session_id: "s1" })],
    [["session-start"], "{"],
    [[], ""],
  ];
  for (const [args, input] of inputs) {
    const result = spawnSync(process.execPath, [hook, ...args], { input, encoding: "utf8", env });
    assert.equal(result.status, 0, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
  }
});

test("観測の本文。turn の 2 種と許可待ちだけを送り、サブエージェントと他の通知は送らない", () => {
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", message: { content: "q" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "from transcript\nsecond" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
    "",
  ].join("\n"));
  assert.deepEqual(observeBody("turn_start", { session_id: "s", prompt: "p" }), { kind: "turn_start", sessionId: "s", prompt: "p" });
  assert.deepEqual(observeBody("turn_start", { session_id: "s" }), { kind: "turn_start", sessionId: "s", prompt: "" });
  assert.equal(observeBody("turn_start", { session_id: "s", agent_id: "a", prompt: "p" }), undefined);
  assert.equal(observeBody("turn_start", { prompt: "p" }), undefined);
  const long = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n") + "\n" + "x".repeat(7000);
  const done = observeBody("turn_done", { session_id: "s", last_assistant_message: long })!;
  assert.equal(done.kind, "turn_done");
  assert.equal(done.summary, "line 0\nline 1\nline 2");
  assert.equal((done.reply as string).length, REPLY_LIMIT);
  assert.deepEqual(observeBody("turn_done", { session_id: "s", transcript_path: transcript }),
    { kind: "turn_done", sessionId: "s", summary: "from transcript\nsecond", reply: "from transcript\nsecond" });
  assert.equal(observeBody("turn_done", { session_id: "s", stop_hook_active: true, last_assistant_message: "x" }), undefined);
  assert.equal(lastAssistantText(join(root, "missing.jsonl")), "");
  assert.deepEqual(observeBody("notification", { session_id: "s", notification_type: "permission_prompt", message: "Bash" }),
    { kind: "waiting", sessionId: "s", reason: "permission" });
  assert.equal(observeBody("notification", { session_id: "s", notification_type: "idle_prompt" }), undefined);
  assert.equal(observeBody("unknown", { session_id: "s" }), undefined);
});

test("hook は POST で session の登録と終了と観測を送る", async (t) => {
  const received: { url: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    received.push({ url: req.url ?? "", body: JSON.parse(body) });
    res.writeHead(200).end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("sandbox blocks local HTTP listen"); return; }
    throw error;
  }
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = process.env.AGENT_GRAPH_PORT;
  process.env.AGENT_GRAPH_PORT = String(address.port);
  try {
    await registerSession({ session_id: "s2", cwd: root, model: "fable" });
    await observe("turn_start", { session_id: "s 2", prompt: "hi" });
    await observe("notification", { session_id: "s2", notification_type: "permission_prompt" });
    await observe("turn_done", { session_id: "s2", last_assistant_message: "done" });
    await endSession({ session_id: "s 2" });
    assert.deepEqual(received, [
      { url: "/api/sessions", body: { id: "s2", cwd: root, client: "claude", pid: process.ppid, model: "fable" } },
      { url: "/api/observe", body: { kind: "turn_start", sessionId: "s 2", prompt: "hi" } },
      { url: "/api/observe", body: { kind: "waiting", sessionId: "s2", reason: "permission" } },
      { url: "/api/observe", body: { kind: "turn_done", sessionId: "s2", summary: "done", reply: "done" } },
      { url: "/api/sessions/s%202/end", body: {} },
    ]);
  } finally {
    if (previous === undefined) delete process.env.AGENT_GRAPH_PORT;
    else process.env.AGENT_GRAPH_PORT = previous;
    server.close();
  }
});
