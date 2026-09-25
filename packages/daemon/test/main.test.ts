import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHandler, startDaemon } from "../src/main.ts";
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
  process.env.XDG_STATE_HOME = dir;
  process.env.AGENT_GRAPH_SOCKET = join(dir, "daemon.sock");
  let daemon;
  try {
    const pidPath = join(dir, "agent-graph/run/daemon.pid");
    await mkdir(join(dir, "agent-graph/run"), { recursive: true });
    await writeFile(pidPath, `${process.pid}\n`);
    await assert.rejects(startDaemon(), /already running/);
    assert.equal(existsSync(pidPath), true);
    await rm(pidPath);
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
    assert.equal(existsSync(process.env.AGENT_GRAPH_SOCKET), true);
    await daemon.stop();
    assert.equal(existsSync(process.env.AGENT_GRAPH_SOCKET), false);
    assert.equal(existsSync(join(dir, "agent-graph/run/daemon.pid")), false);
    assert.equal(existsSync(join(dir, "agent-graph/run/daemon.log")), true);
  } finally {
    await daemon?.stop();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldSocket === undefined) delete process.env.AGENT_GRAPH_SOCKET; else process.env.AGENT_GRAPH_SOCKET = oldSocket;
    await rm(dir, { recursive: true, force: true });
  }
});
