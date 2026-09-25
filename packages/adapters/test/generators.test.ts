import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateClaudePlugin } from "../src/claude-plugin.ts";
import { installCodexConfig, renderCodexOverrides } from "../src/codex-config.ts";

const options = { shimPath: "/tmp/shim.ts", nodePath: process.execPath };
const root = mkdtempSync(join(tmpdir(), "agent-graph-adapters-"));

test("Claude plugin の JSON と hook", () => {
  const outDir = join(root, "plugin");
  generateClaudePlugin({ outDir, ...options });
  const manifest = JSON.parse(readFileSync(join(outDir, ".claude-plugin/plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(outDir, ".mcp.json"), "utf8"));
  const hooks = JSON.parse(readFileSync(join(outDir, "hooks/hooks.json"), "utf8"));
  const settings = JSON.parse(readFileSync(join(outDir, "recommended-settings.json"), "utf8"));
  assert.equal(manifest.name, "agent-graph");
  assert.deepEqual(mcp.mcpServers["agent-graph"], { command: process.execPath, args: [options.shimPath], env: { AGENT_GRAPH_CLIENT: "claude" } });
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
  assert.match(hooks.hooks.SessionStart[0].hooks[0].command, /agent-graph-hook session-start/);
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
});

test("hook は到達不能でも 0 で終わる", () => {
  const hook = fileURLToPath(new URL("../src/hook.ts", import.meta.url));
  const result = spawnSync(process.execPath, [hook, "session-start"], {
    input: JSON.stringify({ session_id: "s1", cwd: root }), encoding: "utf8",
    env: { ...process.env, AGENT_GRAPH_PORT: "1" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("hook は POST で session を送る", async (t) => {
  let received: unknown;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/api/sessions");
    received = JSON.parse(body);
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
    const { registerSession } = await import("../src/hook.ts");
    await registerSession({ session_id: "s2", cwd: root });
    assert.deepEqual(received, { id: "s2", cwd: root, client: "claude" });
  } finally {
    if (previous === undefined) delete process.env.AGENT_GRAPH_PORT;
    else process.env.AGENT_GRAPH_PORT = previous;
    server.close();
  }
});
