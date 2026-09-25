import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { registerSession } from "../src/http/sessions.ts";
import { startHttpServer } from "../src/http/server.ts";

function createFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-session-")));
  execFileSync("git", ["init", "-q", root]);
  const cwd = join(root, "subdir");
  mkdirSync(cwd);
  const key = repoKey(root);
  const store = openStore(":memory:");
  store.upsertRepo({ key, rootPath: root, name: "test" });
  const stores = new Map([[key, store]]);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, key, store, stores };
}

test("セッション登録は git ルートを解決し、再送でも開始イベントを一度だけ記録する", async (t) => {
  const { cwd, key, store, stores } = createFixture(t);
  const body = { id: "session", cwd, client: "claude" };
  await Promise.all([registerSession(body, stores), registerSession(body, stores)]);
  const session = store.db.prepare("SELECT * FROM sessions").get()!;
  assert.equal(session.id, body.id);
  assert.equal(session.repo_key, key);
  assert.equal(session.client, "claude");
  const events = store.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "session.started");
  assert.equal(events[0].session, body.id);
  assert.equal(events[0].trace.traceId, session.trace_id);
  assert.deepEqual(events[0].payload, { sessionId: body.id });
  store.insertSession({ id: "mcp-first", repoKey: key, name: "mcp-first", client: "codex",
    traceId: "a".repeat(32), startedAt: new Date().toISOString() });
  await registerSession({ id: "mcp-first", cwd, client: "codex" }, stores);
  assert.equal(store.listEvents().find((event) => event.session === "mcp-first")?.trace.traceId, "a".repeat(32));
});

test("不正なセッション入力を保存しない", async (t) => {
  const { cwd, store, stores } = createFixture(t);
  for (const body of [null, [], {}, { id: " ", cwd, client: "claude" },
    { id: "s", cwd, client: "unknown" }, { id: "s", cwd: ".", client: "claude" },
    { id: "s", cwd: join(cwd, "missing"), client: "claude" }]) {
    await assert.rejects(registerSession(body, stores), TypeError);
  }
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM sessions").get()?.n, 0);
  assert.equal(store.listEvents().length, 0);
});

test("planner のセッション登録と再送を受け付ける", async (t) => {
  const { cwd, store, stores } = createFixture(t);
  const body = { id: "planner", cwd, client: "planner" };
  await registerSession(body, stores);
  await registerSession(body, stores);
  assert.equal(store.db.prepare("SELECT client FROM sessions WHERE id = ?").get(body.id)?.client, "planner");
  assert.equal(store.listEvents().length, 1);
  await assert.rejects(registerSession({ ...body, client: "codex" }, stores), /client does not match/);
});

test("未接続のリポジトリも状態ディレクトリへ登録する", async (t) => {
  const { root, cwd, key } = createFixture(t);
  const state = mkdtempSync(join(tmpdir(), "agent-graph-session-state-"));
  const previous = process.env.XDG_STATE_HOME;
  const stores = new Map<string, Store>();
  process.env.XDG_STATE_HOME = state;
  t.after(() => {
    for (const store of stores.values()) store.close();
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(state, { recursive: true, force: true });
  });
  await registerSession({ id: "new-repo", cwd, client: "claude" }, stores);
  assert.ok(existsSync(stateDbPath(key)));
  const store = stores.get(key)!;
  assert.equal(store.db.prepare("SELECT root_path FROM repos WHERE key = ?").get(key)?.root_path, root);
  assert.equal(store.listEvents()[0].kind, "session.started");
});

test("POST /api/sessions は登録に 201、不正な body に 400 を返す", async (t) => {
  const { root, cwd, stores } = createFixture(t);
  let server;
  try { server = await startHttpServer({ port: 0, openStores: stores, listRepos: () => [], tokenPath: join(root, "dashboard.token") }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  const url = `http://127.0.0.1:${address.port}/api/sessions`;
  const headers = { "content-type": "application/json" };
  for (const body of ["{", "null", "{}", "x".repeat(16_385)]) {
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 400);
  }
  assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ id: "s", cwd, client: "claude" }) })).status, 201);
});
