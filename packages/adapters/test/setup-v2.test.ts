import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeCodexConfig } from "../src/codex-config.ts";
import { renderLaunchdPlist } from "../src/launchd.ts";
import { generateMarketplace, renderMarketplace } from "../src/marketplace.ts";
import { setupAgentGraphV2, type SetupV2Options } from "../src/setup-v2.ts";
import { projectProjects } from "../../core/src/ledger/projections/projects.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { openStore } from "../../core/src/store/store.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DAEMON = "dev.agent-graph.daemon";
const RUNNER = "dev.agent-graph.runner";
const API = "dev.agent-graph.api";

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return [[entry.name, `link:${readlinkSync(path)}`]];
    return entry.isDirectory() ? Object.entries(snapshot(path)).map(([name, content]) => [`${entry.name}/${name}`, content])
      : [[entry.name, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  }));
}

function createFixture(t: { after: (callback: () => void) => void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cutover-home-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, ".local/state/agent-graph");
  const plistDir = join(home, "Library/LaunchAgents");
  const marketplaceDir = join(home, ".local/share/agent-graph/marketplace");
  const configPath = join(home, ".codex/config.toml");
  const bin = join(home, "bin");
  mkdirSync(bin); mkdirSync(plistDir, { recursive: true }); mkdirSync(join(home, ".codex"));
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "claude"), 0o755);
  const plugin = { nodePath: process.execPath, shimPath: join(ROOT, "packages/daemon/src/shim.ts"), hookPath: join(ROOT, "packages/adapters/src/hook.ts") };
  generateMarketplace({ outDir: marketplaceDir, plugin });
  const unrelated = 'model = "custom"\n[mcp_servers.other]\ncommand = "other"\n';
  const config = mergeCodexConfig(unrelated, plugin);
  writeFileSync(configPath, config);
  const plist = renderLaunchdPlist({ nodePath: process.execPath, daemonPath: join(ROOT, "packages/daemon/src/main.ts"), logDir: join(state, "run"), env: { HOME: home, PATH: bin } });
  writeFileSync(join(plistDir, `${DAEMON}.plist`), plist);
  const loaded = new Set([DAEMON]);
  const calls: string[][] = [];
  const messages: string[] = [];
  const failures = new Set<string>();
  const options: SetupV2Options = {
    home, nodePath: process.execPath, rootPath: ROOT, platform: "darwin", uid: 123,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, temporaryRoots: [join(home, "temporary")],
    log: (line) => messages.push(line),
    run(command, args) {
      calls.push([command, ...args]);
      if (command === "launchctl") {
        const label = args[0] === "bootstrap" ? args[2].split("/").at(-1)!.replace(/\.plist$/, "") : args[1].split("/").at(-1)!;
        if (failures.has(args[0])) return { status: 1, stdout: "", stderr: "injected failure" };
        if (args[0] === "print") return { status: loaded.has(label) ? 0 : 1, stdout: "state = running\npid = 123\n", stderr: "" };
        if (args[0] === "bootout") loaded.delete(label);
        if (args[0] === "bootstrap") loaded.add(label);
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command.endsWith("/claude")) {
        const value = args[1] === "marketplace" ? [{ name: "agent-graph-local", source: "directory", path: marketplaceDir }]
          : [{ id: "agent-graph@agent-graph-local", scope: "user", enabled: true }];
        return { status: 0, stdout: args.at(-1) === "--json" ? JSON.stringify(value) : "", stderr: "" };
      }
      const result = spawnSync(command, args, { encoding: "utf8", cwd: ROOT, env: { ...process.env, ...options.env, HOME: home }, timeout: 60_000 });
      if (result.error) throw result.error;
      return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
  function git(args: string[]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const repo = join(home, "projects/main");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", repo]);
  git(["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  const worktree = join(home, "projects/worktree");
  git(["-C", repo, "worktree", "add", "-qb", "child", worktree]);
  const temporary = join(home, "temporary/repo");
  mkdirSync(temporary, { recursive: true }); git(["init", "-q", temporary]);
  const alias = join(home, "projects/alias"); symlinkSync(repo, alias);
  const legacy = join(state, "legacy/agent-graph.db");
  mkdirSync(join(state, "legacy"), { recursive: true });
  const store = openStore(legacy);
  for (const [index, path] of [worktree, temporary, repo, alias].entries()) store.db.prepare("INSERT INTO repos (key, root_path, name) VALUES (?, ?, ?)").run(`repo-${index}`, path, `Project ${index}`);
  store.close();
  return { home, options, state, plistDir, marketplaceDir, configPath, config, plist, calls, messages, loaded, failures, repo, worktree, temporary, legacy };
}

function readProjects(state: string) {
  const ledger = openLedger(join(state, "agent-graph.db"));
  try { return { facts: ledger.readSince(0, Number.MAX_SAFE_INTEGER), projects: projectProjects(ledger.readSince(0, Number.MAX_SAFE_INTEGER)) }; }
  finally { ledger.close(); }
}

test("v2 dry-run は全手順を表示し HOME と launchd を変更しない", async (t) => {
  const f = createFixture(t);
  const before = snapshot(f.home);
  await setupAgentGraphV2({ ...f.options, dryRun: true });
  assert.deepEqual(snapshot(f.home), before);
  assert.deepEqual([...f.loaded], [DAEMON]);
  assert.ok(f.calls.filter(([command]) => command === "launchctl").every((call) => call[1] === "print"));
  for (const pattern of [/bootout.*daemon/, /api migrate/, /プロジェクト unregistered/, /runner\.plist/, /api\.plist/, /Claude hook/, /Codex MCP/]) {
    assert.match(f.messages.join("\n"), pattern);
  }
});

test("WAL 更新中の dry-run は旧 DB の補助ファイルも変更しない", async (t) => {
  const f = createFixture(t);
  const db = new DatabaseSync(f.legacy);
  try {
    db.prepare("UPDATE repos SET name = ? WHERE key = ?").run("Latest project", "repo-2");
    const before = snapshot(f.home);
    await setupAgentGraphV2({ ...f.options, dryRun: true });
    assert.deepEqual(snapshot(f.home), before);
    assert.ok(f.messages.some((line) => line.startsWith("プロジェクト一覧は旧 daemon の停止後に確認:")));
    assert.ok(f.messages.some((line) => line.startsWith("api で通常のリポジトリだけをプロジェクト登録")));
  } finally { db.close(); }
});

test("実行は旧 daemon を外して移行し通常プロジェクトを登録して接続を切り替える", async (t) => {
  const f = createFixture(t);
  const legacyBefore = readFileSync(f.legacy);
  await setupAgentGraphV2(f.options);
  assert.deepEqual(readFileSync(f.legacy), legacyBefore);
  assert.deepEqual([...f.loaded].sort(), [API, RUNNER].sort());
  assert.equal(existsSync(join(f.plistDir, `${DAEMON}.plist`)), false);
  assert.equal(readFileSync(join(f.state, "cutover-v1-daemon.plist"), "utf8"), f.plist);
  const api = readFileSync(join(f.plistDir, `${API}.plist`), "utf8");
  assert.match(api, /<string>serve<\/string>/);
  assert.match(api, /<string>--dashboard-port<\/string><string>7420<\/string>/);
  assert.match(api, /<string>--port<\/string><string>0<\/string>/);
  const runner = readFileSync(join(f.plistDir, `${RUNNER}.plist`), "utf8");
  assert.match(runner, /runner\/src\/cli\.ts/); assert.match(runner, /runner\.sock/);
  assert.doesNotMatch(runner, /WatchPaths|QueueDirectories/);
  const bootout = f.calls.findIndex((call) => call[1] === "bootout" && call[2].endsWith(DAEMON));
  const migrate = f.calls.findIndex((call) => call[2] === "migrate");
  const bootstrap = f.calls.findIndex((call) => call[1] === "bootstrap" && call[3].endsWith(`${API}.plist`));
  assert.ok(bootout < migrate && migrate < bootstrap);
  const registered = readProjects(f.state).projects.filter((project) => project.state === "registered");
  assert.equal(registered.length, 1); assert.equal(registered[0].root_path, f.repo);
  assert.ok(readProjects(f.state).projects.some((project) => project.root_path === f.temporary && project.state === "unregistered"));
  const config = readFileSync(f.configPath, "utf8");
  assert.equal(config.split("[mcp_servers.agent-graph]").length, 2);
  assert.ok(config.startsWith(f.config.slice(0, f.config.indexOf("[mcp_servers.agent-graph]"))));
  assert.match(config, /shim-v2\/cli\.ts/);
  const hooks = readFileSync(join(f.marketplaceDir, "plugins/agent-graph/hooks/hooks.json"), "utf8");
  assert.match(hooks, /hook-v2\/cli\.ts/); assert.doesNotMatch(hooks, /observe turn_start|session-start/);
  assert.match(readFileSync(join(f.marketplaceDir, "plugins/agent-graph/.mcp.json"), "utf8"), /shim-v2\/cli\.ts/);
  assert.ok(f.calls.some((call) => call.slice(1).join(" ") === "plugin update agent-graph@agent-graph-local"));
  const factCount = readProjects(f.state).facts.length;
  f.calls.length = 0;
  await setupAgentGraphV2(f.options);
  assert.equal(readProjects(f.state).facts.length, factCount);
  assert.ok(f.calls.every((call) => call[1] !== "bootstrap" && call[1] !== "bootout"));
});

test("rollback は v2 を外して旧 plist と接続を復元し新台帳を保持する", async (t) => {
  const f = createFixture(t);
  await setupAgentGraphV2(f.options);
  // 切り替え後に追加された利用者の設定も保持する。
  writeFileSync(f.configPath, readFileSync(f.configPath, "utf8") + '[preferences]\ncustom = true\n');
  const before = snapshot(f.home);
  f.calls.length = 0;
  await setupAgentGraphV2({ ...f.options, rollbackV1: true, dryRun: true });
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(f.calls.every((call) => call[1] !== "bootstrap" && call[1] !== "bootout"));
  const count = readProjects(f.state).facts.length;
  await setupAgentGraphV2({ ...f.options, rollbackV1: true });
  assert.deepEqual([...f.loaded], [DAEMON]);
  assert.equal(readFileSync(join(f.plistDir, `${DAEMON}.plist`), "utf8"), f.plist);
  assert.equal(existsSync(join(f.plistDir, `${RUNNER}.plist`)), false);
  assert.equal(existsSync(join(f.plistDir, `${API}.plist`)), false);
  assert.equal(readFileSync(f.configPath, "utf8"), f.config + '[preferences]\ncustom = true\n');
  const expected = renderMarketplace({ outDir: f.marketplaceDir, plugin: {
    nodePath: process.execPath, shimPath: join(ROOT, "packages/daemon/src/shim.ts"), hookPath: join(ROOT, "packages/adapters/src/hook.ts"),
  } });
  for (const [path, body] of Object.entries(expected)) assert.equal(readFileSync(join(f.marketplaceDir, path), "utf8"), body);
  assert.equal(readProjects(f.state).facts.length, count);
});

test("doctor は常駐状態と接続先を読み取りだけで表示する", async (t) => {
  const f = createFixture(t);
  for (const version of ["v1", "v2"]) {
    if (version === "v2") await setupAgentGraphV2(f.options);
    const before = snapshot(f.home);
    f.messages.length = 0;
    await setupAgentGraphV2({ ...f.options, doctor: true });
    assert.deepEqual(snapshot(f.home), before);
    for (const client of ["Claude hook", "Claude MCP", "Codex MCP"]) assert.ok(f.messages.includes(`${client}: ${version}`));
    assert.ok(f.messages.some((line) => line.startsWith(`${RUNNER}:`)));
    assert.ok(f.messages.some((line) => line.startsWith(`${API}:`)));
  }
});

test("旧 daemon の停止失敗では移行と api 起動へ進まない", async (t) => {
  const f = createFixture(t);
  f.failures.add("bootout");
  await assert.rejects(setupAgentGraphV2(f.options), /injected failure/);
  assert.ok(f.calls.every((call) => call[2] !== "migrate" && call[1] !== "bootstrap"));
  assert.equal(readFileSync(f.configPath, "utf8"), f.config);
  assert.ok(existsSync(join(f.plistDir, `${DAEMON}.plist`)));
});

test("変更された稼働 runner の設定は再起動せず拒否する", async (t) => {
  const f = createFixture(t);
  await setupAgentGraphV2(f.options);
  const before = snapshot(f.home);
  f.calls.length = 0;
  await assert.rejects(setupAgentGraphV2({ ...f.options, env: { ...f.options.env, XDG_CACHE_HOME: join(f.home, "cache") } }), /runner の設定が変わっています/);
  assert.deepEqual(snapshot(f.home), before);
  assert.ok(f.calls.every((call) => call[1] !== "bootout" && call[1] !== "bootstrap"));
});

test("シェル入口は v2 と rollback の dry-run を偽 launchctl で受け付ける", (t) => {
  const f = createFixture(t);
  symlinkSync(process.execPath, join(f.home, "bin/node"));
  // CLI の一覧問い合わせを空にし、外部クライアントへの変更を避ける。
  writeFileSync(join(f.home, "bin/claude"), '#!/bin/sh\nprintf "[]\\n"\n');
  const marker = join(f.home, "launchctl-mutated");
  writeFileSync(join(f.home, "bin/launchctl"), `#!/bin/sh\nif [ "$1" = print ]; then exit 1; fi\ntouch '${marker}'\n`);
  chmodSync(join(f.home, "bin/launchctl"), 0o755);
  const script = join(ROOT, "scripts/setup.sh");
  const before = snapshot(f.home);
  for (const flag of ["--v2", "--rollback-v1"]) {
    const result = spawnSync("/bin/bash", [script, flag, "--dry-run"], {
      encoding: "utf8", env: { HOME: f.home, PATH: `${f.home}/bin:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /launchctl bootstrap/);
  }
  assert.deepEqual(snapshot(f.home), before);
  assert.equal(existsSync(marker), false);
});
