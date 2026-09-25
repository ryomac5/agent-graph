import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHandler, startDaemon, startUsageProbe } from "../src/main.ts";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { existsSync } from "node:fs";

test("handler restores caller and reuses repository store across nested cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ag-main-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldPolicy = process.env.AGENT_GRAPH_POLICY_JSON;
  const stores = new Map<string, Store>();
  try {
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.AGENT_GRAPH_POLICY_JSON = join(dir, "policy.json");
    await writeFile(process.env.AGENT_GRAPH_POLICY_JSON, JSON.stringify({ roles: {
      implement: [], document: [], review: [], research: [], orchestrate: [],
    } }));
    const root = join(dir, "repo");
    await mkdir(join(root, "nested"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    const canonical = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).trim();
    const key = repoKey(canonical);
    const seed = openStore(stateDbPath(key));
    seed.upsertRepo({ key, rootPath: canonical, name: "repo" });
    const traceId = "a".repeat(32);
    seed.insertSession({ id: "session", repoKey: key, name: "session", client: "test", traceId, startedAt: new Date().toISOString() });
    seed.insertDelegation({ id: "parent", repoKey: key, sessionId: "session", role: "orchestrate", title: "parent", status: "done" });
    seed.close();
    const handler = createHandler(stores);
    const hello = { type: "hello" as const, cwd: join(root, "nested"), pid: process.pid,
      traceparent: `00-${traceId}-${"b".repeat(16)}-01`,
      tracestate: "agent-graph=session:session;delegation:parent", session: "ignored" };
    const request = { role: "implement" as const, title: "test", task: "test", accept: ["true"], review: false };
    await handler(request, hello);
    const store = stores.get(key)!;
    await handler(request, { ...hello, cwd: root });
    assert.equal(stores.size, 1);
    assert.equal(stores.get(key), store);
    const rows = store.db.prepare("SELECT * FROM delegations WHERE parent_id = 'parent'").all();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.session_id, "session");
      assert.equal(row.status, "denied");
    }
    for (const span of store.db.prepare("SELECT * FROM spans").all()) {
      assert.equal(span.trace_id, traceId);
      assert.equal(span.parent_span_id, "b".repeat(16));
      assert.equal(span.trace_state, hello.tracestate);
    }
  } finally {
    for (const store of stores.values()) store.close();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldPolicy === undefined) delete process.env.AGENT_GRAPH_POLICY_JSON; else process.env.AGENT_GRAPH_POLICY_JSON = oldPolicy;
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon rejects duplicate PID and cleans runtime files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ag-life-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldSocket = process.env.AGENT_GRAPH_SOCKET;
  const oldProbe = process.env.AGENT_GRAPH_USAGE_PROBE;
  const oldPort = process.env.AGENT_GRAPH_PORT;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = dir;
  process.env.AGENT_GRAPH_SOCKET = join(dir, "daemon.sock");
  process.env.AGENT_GRAPH_USAGE_PROBE = "0";
  process.env.AGENT_GRAPH_PORT = "0";
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  let daemon;
  try {
    const pidPath = join(dir, "agent-graph/run/daemon.pid");
    await mkdir(join(dir, "agent-graph/run"), { recursive: true });
    await writeFile(pidPath, `${process.pid}\n`);
    await assert.rejects(startDaemon(), /already running/);
    assert.equal(existsSync(pidPath), true);
    await writeFile(pidPath, "99999999\n");
    assert.throws(() => process.kill(99999999, 0), { code: "ESRCH" });
    try { daemon = await startDaemon(); }
    catch (error) {
      assert.equal(existsSync(join(dir, "agent-graph/run/daemon.pid")), false);
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Unix socket listen is prohibited by the sandbox");
        return;
      }
      throw error;
    }
    await assert.rejects(startDaemon(), /already running/);
    assert.equal(await readFile(pidPath, "utf8"), `${process.pid}\n`);
    assert.equal(existsSync(process.env.AGENT_GRAPH_SOCKET), true);
    const log = await readFile(join(dir, "agent-graph/run/daemon.log"), "utf8");
    const url = log.match(/dashboard (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
    assert.ok(url, "dashboard URL is logged");
    const response = await fetch(url);
    assert.equal(response.status, 200);
    await daemon.stop();
    await assert.rejects(fetch(url));
    assert.equal(existsSync(process.env.AGENT_GRAPH_SOCKET), false);
    assert.equal(existsSync(join(dir, "agent-graph/run/daemon.pid")), false);
    assert.equal(existsSync(join(dir, "agent-graph/run/daemon.log")), true);
  } finally {
    await daemon?.stop();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldSocket === undefined) delete process.env.AGENT_GRAPH_SOCKET; else process.env.AGENT_GRAPH_SOCKET = oldSocket;
    if (oldProbe === undefined) delete process.env.AGENT_GRAPH_USAGE_PROBE; else process.env.AGENT_GRAPH_USAGE_PROBE = oldProbe;
    if (oldPort === undefined) delete process.env.AGENT_GRAPH_PORT; else process.env.AGENT_GRAPH_PORT = oldPort;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon bin starts through a symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ag-bin-"));
  try {
    const pidPath = join(dir, "agent-graph/run/daemon.pid");
    await mkdir(join(dir, "agent-graph/run"), { recursive: true });
    await writeFile(pidPath, `${process.pid}\n`);
    const binPath = join(dir, "agent-graph-daemon");
    await symlink(fileURLToPath(new URL("../src/main.ts", import.meta.url)), binPath);
    const result = spawnSync(process.execPath, [binPath], {
      env: { ...process.env, XDG_STATE_HOME: dir, AGENT_GRAPH_USAGE_PROBE: "0" }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Daemon is already running/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("周期取得を保存し、環境変数で停止する", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ag-probe-"));
  const store = openStore(":memory:");
  store.upsertRepo({ key: "repo", rootPath: process.cwd(), name: "repo" });
  const stores = new Map([["repo", store]]);
  const timers: Array<() => void> = [];
  const intervals: number[] = [];
  let codexCalls = 0;
  let claudeCalls = 0;
  const options = {
    env: { XDG_CACHE_HOME: dir },
    readCodex: () => { codexCalls++; return [{ ts: new Date().toISOString(), provider: "openai" as const, window: "5h", percent: 42 }]; },
    probeClaude: async (cwd: string) => { claudeCalls++; assert.equal(cwd, join(dir, "agent-graph", "usage-probe"));
      return [{ ts: new Date().toISOString(), provider: "anthropic" as const, window: "5h", percent: 32 }]; },
    setIntervalImpl: ((fn: () => void, ms: number) => { timers.push(fn); intervals.push(ms); return 1; }) as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
  };
  try {
    const probe = startUsageProbe(stores, options);
    assert.deepEqual(intervals, [60_000, 300_000]);
    for (const timer of timers) timer();
    await probe.stop();
    assert.equal(codexCalls, 1);
    assert.equal(claudeCalls, 1);
    assert.equal(store.latestUsageSamples().length, 2);
    assert.equal(store.listEvents().filter((event) => event.kind === "usage.sampled").length, 2);
    startUsageProbe(stores, { ...options, env: { AGENT_GRAPH_USAGE_PROBE: "0" } });
    assert.equal(timers.length, 2);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("store 作成前の取得値を初回委譲時に保存して割り当てへ渡す", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ag-early-"));
  const oldState = process.env.XDG_STATE_HOME;
  const oldPolicy = process.env.AGENT_GRAPH_POLICY_JSON;
  const stores = new Map<string, Store>();
  const latest = new Map();
  const timers: Array<() => void> = [];
  try {
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.AGENT_GRAPH_POLICY_JSON = join(dir, "policy.json");
    await writeFile(process.env.AGENT_GRAPH_POLICY_JSON, JSON.stringify({ roles: {
      research: [{ executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" }],
    } }));
    const root = join(dir, "repo");
    await mkdir(root);
    execFileSync("git", ["init", "-q", root]);
    const probe = startUsageProbe(stores, {
      latest,
      env: { XDG_CACHE_HOME: dir },
      readCodex: () => [],
      probeClaude: async () => [{ ts: new Date().toISOString(), provider: "anthropic", window: "5h", percent: 95 }],
      setIntervalImpl: ((fn: () => void) => { timers.push(fn); return 1; }) as typeof setInterval,
      clearIntervalImpl: (() => {}) as typeof clearInterval,
    });
    timers[1]();
    await probe.stop();
    assert.equal(stores.size, 0);
    const result = await createHandler(stores, latest)(
      { role: "research", title: "調査", task: "調べる", accept: ["true"], review: false },
      { type: "hello", cwd: root, pid: process.pid },
    );
    assert.equal(result.status, "denied");
    assert.match(result.assignment.reason.join(" "), /sonnet excluded at 95%/);
    const store = [...stores.values()][0];
    assert.equal(store.latestUsageSamples()[0].percent, 95);
    assert.equal(store.listEvents().filter((event) => event.kind === "usage.sampled").length, 1);
  } finally {
    for (const store of stores.values()) store.close();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldPolicy === undefined) delete process.env.AGENT_GRAPH_POLICY_JSON; else process.env.AGENT_GRAPH_POLICY_JSON = oldPolicy;
    await rm(dir, { recursive: true, force: true });
  }
});
