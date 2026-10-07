import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { findExecutable, setupAgentGraph, type SetupOptions } from "../src/setup.ts";

function createFixture(t: { after: (callback: () => void) => void }, withClients = true) {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-new-pc-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin");
  mkdirSync(bin);
  if (withClients) for (const name of ["claude", "codex", "herdr"]) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  const calls: string[][] = [];
  const messages: string[] = [];
  const state = { loaded: false, serviceOutput: "", registered: false, installed: false, enabled: true, bootstrapStatus: 0, herdrRunning: true, claudeLoggedIn: true, codexLoggedIn: true };
  const marketplaceDir = join(home, ".local", "share", "agent-graph", "marketplace");
  const configPath = join(home, ".codex", "config.toml");
  const options: SetupOptions = {
    home, platform: "darwin", uid: 123, nodePath: join(bin, "node"), env: { PATH: bin }, log: (line) => messages.push(line),
    wait: async () => "http://127.0.0.1:7420/",
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "launchctl") {
        if (args[0] === "print") return { status: state.loaded ? 0 : 1, stdout: state.serviceOutput, stderr: "" };
        if (args[0] === "bootstrap") {
          if (args[2].includes("dev.agent-graph.herdr")) state.herdrRunning = state.bootstrapStatus === 0;
          else state.loaded = state.bootstrapStatus === 0;
          return { status: state.bootstrapStatus, stdout: "", stderr: "bootstrap error" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args.join(" ") === "status server") return { status: state.herdrRunning ? 0 : 1, stdout: "", stderr: "" };
      if (args.join(" ") === "auth status --json") return { status: 0, stdout: JSON.stringify({ loggedIn: state.claudeLoggedIn }), stderr: "" };
      if (args.join(" ") === "login status") return { status: state.codexLoggedIn ? 0 : 1, stdout: "", stderr: "" };
      if (args.join(" ") === "plugin marketplace list --json") return {
        status: 0, stderr: "", stdout: JSON.stringify(state.registered ? [{ name: "agent-graph-local", source: "directory", path: marketplaceDir }] : []),
      };
      if (args.join(" ") === "plugin list --json") return {
        status: 0, stderr: "", stdout: JSON.stringify(state.installed ? [{ id: "agent-graph@agent-graph-local", scope: "user", enabled: state.enabled }] : []),
      };
      if (args[1] === "marketplace" && args[2] === "add") state.registered = true;
      if (args[1] === "install") state.installed = true;
      if (args[1] === "enable") state.enabled = true;
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { home, bin, calls, messages, state, options, configPath, marketplaceDir };
}

test("新PCの導入は既存Codex設定を保持し、Claudeのユーザー登録と常駐起動まで行う", async (t) => {
  const f = createFixture(t);
  mkdirSync(join(f.home, ".codex"));
  const original = 'model = "custom-model"\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(f.configPath, original);
  const result = await setupAgentGraph(f.options);
  assert.equal(result.url, "http://127.0.0.1:7420/");
  assert.deepEqual(result.warnings, []);
  assert.ok(readFileSync(f.configPath, "utf8").startsWith(original));
  assert.equal(readFileSync(`${f.configPath}.agent-graph.bak`, "utf8"), original);
  assert.ok(f.calls.some((call) => call.slice(1).join(" ") === "plugin install agent-graph@agent-graph-local --scope user"));
  assert.ok(f.calls.some((call) => call[1] === "bootstrap"));
  const plist = readFileSync(join(f.home, "Library", "LaunchAgents", "dev.agent-graph.daemon.plist"), "utf8");
  assert.match(plist, /AGENT_GRAPH_CLAUDE_BIN/);
  assert.match(plist, /AGENT_GRAPH_CODEX_BIN/);
  assert.ok(existsSync(join(f.home, "Library", "LaunchAgents", "dev.agent-graph.herdr.plist")));
});

test("同じ設定で再実行しても設定の重複・再起動・バックアップの上書きをしない", async (t) => {
  const f = createFixture(t);
  mkdirSync(join(f.home, ".codex"));
  writeFileSync(f.configPath, 'model = "original"\n');
  await setupAgentGraph(f.options);
  const config = readFileSync(f.configPath, "utf8");
  const backup = readFileSync(`${f.configPath}.agent-graph.bak`, "utf8");
  f.calls.length = 0;
  await setupAgentGraph(f.options);
  assert.equal(readFileSync(f.configPath, "utf8"), config);
  assert.equal(readFileSync(`${f.configPath}.agent-graph.bak`, "utf8"), backup);
  assert.equal(f.calls.length, 6);
  assert.ok(f.calls.every((call) => call[1] === "print" || call.at(-1) === "--json" || call[1] === "integration" || call[1] === "status"));
});

test("dry-runは設定・サービス・プラグインを変更しない", async (t) => {
  const f = createFixture(t);
  await setupAgentGraph({ ...f.options, dryRun: true });
  assert.equal(existsSync(f.configPath), false);
  assert.equal(existsSync(f.marketplaceDir), false);
  assert.equal(existsSync(join(f.home, "Library")), false);
  assert.equal(f.calls.length, 3);
});

test("独自CODEX_HOMEとXDGのパス、および空白を含むパスを保持する", async (t) => {
  const f = createFixture(t);
  f.options.env = { PATH: f.bin, CODEX_HOME: join(f.home, "codex home"), XDG_STATE_HOME: join(f.home, "state home"), XDG_DATA_HOME: join(f.home, "data home"), TRACEPARENT: "must-not-copy" };
  await setupAgentGraph(f.options);
  assert.ok(existsSync(join(f.home, "codex home", "config.toml")));
  const add = f.calls.find((call) => call[2] === "marketplace" && call[3] === "add")!;
  assert.equal(add[4], join(f.home, "data home", "agent-graph", "marketplace"));
  const plist = readFileSync(join(f.home, "Library", "LaunchAgents", "dev.agent-graph.daemon.plist"), "utf8");
  assert.match(plist, /state home/);
  assert.doesNotMatch(plist, /TRACEPARENT|must-not-copy/);
});

test("CLI未導入でもCodexアプリ設定と常駐起動を行い、不足を伝える", async (t) => {
  const f = createFixture(t, false);
  const result = await setupAgentGraph(f.options);
  assert.equal(result.warnings.length, 3);
  assert.ok(existsSync(f.configPath));
  assert.ok(f.calls.every((call) => call[0] === "launchctl"));
});

test("doctorは登録状況とURLを表示して変更しない", async (t) => {
  const f = createFixture(t);
  await setupAgentGraph(f.options);
  f.calls.length = 0;
  const result = await setupAgentGraph({ ...f.options, doctor: true });
  assert.equal(result.url, "http://127.0.0.1:7420/");
  assert.equal(f.calls.length, 2);
  assert.ok(f.messages.includes("Claude 登録: 有効"));
});

test("登録済みでも無効のClaudeプラグインをユーザー範囲で有効にする", async (t) => {
  const f = createFixture(t);
  await setupAgentGraph(f.options);
  f.state.enabled = false;
  f.calls.length = 0;
  await setupAgentGraph(f.options);
  assert.ok(f.calls.some((call) => call.slice(1).join(" ") === "plugin enable agent-graph@agent-graph-local --scope user"));
  assert.ok(f.calls.every((call) => call[1] !== "bootstrap"));
});

test("サービス起動失敗時には成功URLを出さず失敗を返す", async (t) => {
  const f = createFixture(t);
  f.state.bootstrapStatus = 1;
  await assert.rejects(setupAgentGraph(f.options), /bootstrap failed/);
  assert.ok(f.messages.every((message) => !message.startsWith("ダッシュボード:")));
});

test("起動に失敗している旧サービスは旧HTTPの応答を待たず設定を更新できる", async (t) => {
  const f = createFixture(t);
  await setupAgentGraph(f.options);
  f.state.serviceOutput = "state = spawn scheduled\nlast exit code = 1\n";
  f.options.env = { PATH: f.bin, AGENT_GRAPH_PORT: "7421" };
  let waits = 0;
  f.options.wait = async () => { waits++; return "http://127.0.0.1:7421/"; };
  f.calls.length = 0;
  const result = await setupAgentGraph(f.options);
  assert.equal(waits, 1, "起動確認は新しいサービスに対してだけ行う");
  assert.equal(result.url, "http://127.0.0.1:7421/");
  assert.ok(f.calls.some((call) => call[1] === "bootstrap"));
});

test("配布物の依存が欠落していれば登録や常駐設定の変更より前に失敗する", async (t) => {
  const f = createFixture(t);
  const root = join(f.home, "incomplete");
  for (const [path, body] of [["packages/daemon/src/shim.ts", ""], ["packages/adapters/src/hook.ts", ""],
    ["packages/daemon/src/main.ts", 'import "../../core/src/assign/policy.ts";']] as const) {
    const full = join(root, path); mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true }); writeFileSync(full, body);
  }
  await assert.rejects(setupAgentGraph({ ...f.options, rootPath: root }), /policy\.ts/);
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(f.configPath), false);
});

test("稼働中の委譲がある場合はサービス設定の変更より先に停止する", async (t) => {
  const f = createFixture(t);
  await setupAgentGraph(f.options);
  f.options.env = { PATH: f.bin, AGENT_GRAPH_PORT: "7421" };
  t.mock.method(globalThis, "fetch", async (input: string) => {
    const url = new URL(input);
    assert.equal(url.origin, "http://127.0.0.1:7420");
    return Response.json(url.pathname === "/api/overview" ? { projects: [{ key: "project" }] } : {
      sessions: [], graphs: [{ nodes: [{ kind: "task", status: "running" }] }],
    });
  });
  f.calls.length = 0;
  await assert.rejects(setupAgentGraph(f.options), /実行中の委譲/);
  assert.ok(f.calls.every((call) => call[1] !== "bootout" && call[1] !== "bootstrap"));
});

test("macOS以外と相対パスの設定は変更前に拒否する", async (t) => {
  const f = createFixture(t);
  await assert.rejects(setupAgentGraph({ ...f.options, platform: "linux" }), /macOS/);
  await assert.rejects(setupAgentGraph({ ...f.options, env: { CODEX_HOME: "relative" } }), /絶対パス/);
  assert.equal(f.calls.length, 0);
});

test("起動確認はログ末尾のURLとHTTP APIを確認する", async (t) => {
  const f = createFixture(t);
  const url = "http://127.0.0.1:7420/";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    requests.push(input);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ projects: [] });
  });
  const logDir = join(f.home, ".local", "state", "agent-graph", "run");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "daemon.log"), `dashboard http://127.0.0.1:1/\n${"x".repeat(100_000)}\ndashboard ${url}\n`);
  const result = await setupAgentGraph({ ...f.options, wait: undefined });
  assert.equal(result.url, url);
  assert.deepEqual(requests, [`${url}api/overview`]);
});

test("シェルのdry-runはNodeが不足してもインストールしない", (t) => {
  const f = createFixture(t, false);
  const marker = join(f.home, "brew-installed");
  for (const [name, body] of Object.entries({
    node: "exit 1",
    brew: `if [ "$1" = --prefix ]; then printf '%s\\n' '${f.home}/brew'; else touch '${marker}'; fi`,
  })) {
    const path = join(f.bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const script = fileURLToPath(new URL("../../../scripts/setup.sh", import.meta.url));
  const result = spawnSync("/bin/bash", [script, "--dry-run"], { env: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Node 24 が未導入/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.configPath), false);
});

test("CLIの自動更新用シンボリックリンクを設定に保持する", (t) => {
  const f = createFixture(t, false);
  const version = join(f.home, "claude-version-1");
  writeFileSync(version, "#!/bin/sh\nexit 0\n");
  chmodSync(version, 0o755);
  const entry = join(f.bin, "claude");
  symlinkSync(version, entry);
  assert.equal(findExecutable("claude", f.bin), entry);
});

test("実際のシェル入口からdry-runしても新PCの設定を作らない", (t) => {
  const f = createFixture(t, false);
  symlinkSync(process.execPath, join(f.bin, "node"));
  writeFileSync(join(f.bin, "launchctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(f.bin, "launchctl"), 0o755);
  const script = fileURLToPath(new URL("../../../scripts/setup.sh", import.meta.url));
  const result = spawnSync("/bin/bash", [script, "--dry-run"], { env: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin` }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(f.configPath));
  assert.equal(existsSync(f.configPath), false);
  assert.equal(existsSync(join(f.home, "Library")), false);
});

test("未ログインのCLIだけログインを案内し、認証を再確認してから登録する", async (t) => {
  const f = createFixture(t);
  f.state.claudeLoggedIn = false;
  f.state.codexLoggedIn = false;
  const loggedIn: string[][] = [];
  await setupAgentGraph({ ...f.options, authenticate: true, interactiveRun: (command, args) => {
    loggedIn.push([command, ...args]);
    if (command.endsWith("/claude")) f.state.claudeLoggedIn = true;
    else f.state.codexLoggedIn = true;
    return 0;
  } });
  assert.deepEqual(loggedIn.map((call) => call.slice(1)), [["auth", "login"], ["login"]]);
  await setupAgentGraph({ ...f.options, authenticate: true, interactiveRun: () => { throw new Error("ログイン済みなら再度開かない"); } });
});

test("ログインが未完了なら設定を書かず完了URLも出さない", async (t) => {
  const f = createFixture(t);
  f.state.codexLoggedIn = false;
  await assert.rejects(setupAgentGraph({ ...f.options, authenticate: true, interactiveRun: () => 0 }), /ログインが完了していません/);
  assert.equal(existsSync(f.configPath), false);
  assert.ok(f.messages.every((message) => !message.startsWith("ダッシュボード:")));
});

test("新PCではHerdrも常駐起動し、既存の稼働サーバーは再起動しない", async (t) => {
  const f = createFixture(t);
  f.state.herdrRunning = false;
  await setupAgentGraph(f.options);
  const plist = readFileSync(join(f.home, "Library", "LaunchAgents", "dev.agent-graph.herdr.plist"), "utf8");
  assert.ok(plist.includes(`<string>${join(f.bin, "herdr")}</string><string>server</string>`));
  assert.ok(f.calls.some((call) => call.at(-1)?.endsWith("dev.agent-graph.herdr.plist")));
  f.calls.length = 0;
  await setupAgentGraph(f.options);
  assert.ok(f.calls.every((call) => call[1] !== "bootstrap" && call[1] !== "bootout"));
});
