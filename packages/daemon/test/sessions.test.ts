import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { endSession, NotFoundError, observe, registerSession, summarize } from "../src/sessions.ts";
import { startHttpServer } from "../src/http/server.ts";
import { reconcileLiveness } from "../src/liveness.ts";

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
  assert.equal(session.name, "test-001");
  assert.equal(session.status, "running");
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

test("登録はリポジトリごとの連番で名前を振り、再登録では変えず、model を記録し、pid は受けない", async (t) => {
  const { cwd, store, stores } = createFixture(t);
  await registerSession({ id: "first", cwd, client: "claude", model: "fable" }, stores);
  await registerSession({ id: "second", cwd, client: "codex" }, stores);
  await registerSession({ id: "first", cwd, client: "claude", pid: process.pid }, stores);
  const first = store.getSession("first")!;
  assert.equal(first.name, "test-001");
  assert.equal(first.pid, undefined, "pid は shim の hello だけで記録する");
  assert.equal(first.model, "fable");
  assert.equal(store.getSession("second")?.name, "test-002");
  // 終了済みのセッションの再登録は running に戻す。名前は変えず、lost の委譲は戻さない
  store.insertDelegation({ id: "d", repoKey: store.getSession("first")!.repoKey, sessionId: "first", role: "implement", title: "d", status: "running" });
  assert.equal(store.endSession("first", "2026-09-25T00:00:00.000Z"), true);
  await registerSession({ id: "first", cwd, client: "claude" }, stores);
  const resumed = store.getSession("first")!;
  assert.equal(resumed.status, "running");
  assert.equal(resumed.endedAt, undefined);
  assert.equal(resumed.name, "test-001");
  assert.ok(resumed.lastSeenAt > "2026-09-25T00:00:00.000Z");
  assert.equal(store.db.prepare("SELECT status FROM delegations WHERE id = 'd'").get()?.status, "lost");
  assert.equal(store.listEvents().filter((event) => event.session === "first" && event.kind === "session.started").length, 1,
    "再登録で session.started を重ねない");
  await assert.rejects(registerSession({ id: "third", cwd, client: "claude", model: 1 }, stores), TypeError);
});

test("終了は status と ended_at を書き、走っていた委譲を lost にし、未知のセッションは NotFoundError", async (t) => {
  const { cwd, key, store, stores } = createFixture(t);
  await registerSession({ id: "s", cwd, client: "claude" }, stores);
  store.insertDelegation({ id: "d", repoKey: key, sessionId: "s", role: "implement", title: "d", status: "requested" });
  const now = new Date("2026-09-25T01:00:00.000Z");
  endSession("s", stores, now);
  endSession("s", stores, new Date("2026-09-25T02:00:00.000Z"));
  const session = store.getSession("s")!;
  assert.equal(session.status, "ended");
  assert.equal(session.endedAt, now.toISOString());
  assert.equal(store.db.prepare("SELECT status FROM delegations WHERE id = 'd'").get()?.status, "lost");
  const lost = store.listEvents().filter((event) => event.kind === "delegation.lost");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].session, "s");
  assert.equal((lost[0].payload as { delegationId: string }).delegationId, "d");
  assert.throws(() => endSession("missing", stores), NotFoundError);
});

test("observe は turn の開始と応答を turns に入れ、待ちを設定して次の turn で解除する", async (t) => {
  const { cwd, store, stores } = createFixture(t);
  await registerSession({ id: "s", cwd, client: "claude" }, stores);
  const at = (hour: number) => new Date(`2026-09-25T0${hour}:00:00.000Z`);
  observe({ kind: "turn_start", sessionId: "s", prompt: "  最初の指示\n詳細  " }, stores, at(1));
  observe({ kind: "waiting", sessionId: "s", reason: "permission" }, stores, at(2));
  let session = store.getSession("s")!;
  assert.equal(session.status, "waiting");
  assert.equal(session.waitingReason, "permission");
  assert.equal(session.goal, "最初の指示\n詳細");
  observe({ kind: "turn_done", sessionId: "s", reply: "# 見出し\n\n1 行目\n2 行目\n3 行目\n4 行目" }, stores, at(3));
  session = store.getSession("s")!;
  assert.equal(session.status, "running");
  assert.equal(session.waitingReason, undefined);
  assert.equal(session.lastSeenAt, at(3).toISOString());
  observe({ kind: "turn_start", sessionId: "s", prompt: "次の指示" }, stores, at(4));
  observe({ kind: "waiting", sessionId: "s", reason: "question" }, stores, at(5));
  observe({ kind: "turn_start", sessionId: "s", prompt: "解除" }, stores, at(6));
  assert.equal(store.getSession("s")?.status, "running");
  observe({ kind: "turn_done", sessionId: "s", summary: "手で付けた要約", reply: "x".repeat(7000) }, stores, at(7));
  const turns = store.listTurns("s");
  assert.deepEqual(turns.map((turn) => [turn.prompt, turn.summary, turn.at]), [
    ["  最初の指示\n詳細  ", "# 見出し\n1 行目\n2 行目", at(1).toISOString()],
    ["次の指示", undefined, at(4).toISOString()],
    ["解除", "手で付けた要約", at(6).toISOString()],
  ]);
  assert.equal(turns[0].reply, "# 見出し\n\n1 行目\n2 行目\n3 行目\n4 行目");
  assert.equal(turns[2].reply?.length, 6000);
  assert.equal(store.getSession("s")?.goal, "最初の指示\n詳細");
  for (const body of [null, {}, { kind: "unknown", sessionId: "s" }, { kind: "turn_start" },
    { kind: "waiting", sessionId: "s", reason: "other" }]) {
    assert.throws(() => observe(body, stores), TypeError);
  }
  assert.throws(() => observe({ kind: "turn_start", sessionId: "missing" }, stores), NotFoundError);
  assert.equal(summarize("a\n\n b \nc\nd"), "a\nb\nc");
});

test("POST /api/sessions/<id>/end と /api/observe は hook から通り、未知のセッションに 404 を返す", async (t) => {
  const { root, cwd, store, stores } = createFixture(t);
  let server;
  try { server = await startHttpServer({ port: 0, openStores: stores, listRepos: () => [], tokenPath: join(root, "dashboard.token") }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post("/api/sessions", JSON.stringify({ id: "s", cwd, client: "claude" }))).status, 201);
  assert.equal((await post("/api/observe", JSON.stringify({ kind: "turn_start", sessionId: "s", prompt: "hi" }))).status, 200);
  assert.equal((await post("/api/observe", JSON.stringify({ kind: "turn_done", sessionId: "s", reply: "done" }))).status, 200);
  assert.equal((await post("/api/observe", JSON.stringify({ kind: "turn_start", sessionId: "missing" }))).status, 404);
  assert.equal((await post("/api/observe", JSON.stringify({ kind: "nope", sessionId: "s" }))).status, 400);
  assert.equal((await post("/api/sessions/missing/end", "{}")).status, 404);
  assert.equal((await post("/api/sessions/s/end", "[]")).status, 400);
  const end = await post("/api/sessions/s/end", "{}");
  assert.equal(end.status, 200);
  assert.deepEqual(await end.json(), { ok: true });
  assert.equal(store.getSession("s")?.status, "ended");
  assert.deepEqual(store.listTurns("s").map((turn) => [turn.prompt, turn.summary]), [["hi", "done"]]);
});

test("委譲せず 30 分黙って ended にした根は次の turn で running に戻り、プロセスの死で ended にした根は戻らない", async (t) => {
  const { cwd, key, store, stores } = createFixture(t);
  const at = (hour: number) => new Date(`2026-09-26T0${hour}:00:00.000Z`);
  await registerSession({ id: "idle", cwd, client: "claude" }, stores);
  store.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(at(0).toISOString(), "idle");
  store.insertNamedSession({ id: "dead", repoKey: key, client: "claude", traceId: "b".repeat(32), startedAt: at(0).toISOString(), pid: 11 });
  // idle は pid が無いので 30 分の規則、dead は pid の死で ended になる
  const ended = await reconcileLiveness(store, { now: () => at(1), isAlive: async () => false });
  assert.deepEqual(ended.sort(), ["dead", "idle"]);
  assert.equal(store.getSession("idle")?.endedReason, "idle");
  assert.equal(store.getSession("dead")?.endedReason, "process_exit");
  await registerSession({ id: "hooked", cwd, client: "claude" }, stores);
  endSession("hooked", stores, at(1));
  observe({ kind: "turn_start", sessionId: "idle", prompt: "続き" }, stores, at(2));
  observe({ kind: "turn_start", sessionId: "dead", prompt: "続き" }, stores, at(2));
  const idle = store.getSession("idle")!;
  assert.equal(idle.status, "running");
  assert.equal(idle.endedAt, undefined);
  assert.equal(idle.endedReason, undefined);
  assert.equal(idle.lastSeenAt, at(2).toISOString());
  assert.equal(store.getSession("dead")?.status, "ended");
  assert.equal(store.getSession("dead")?.endedReason, "process_exit");
  // turn_done と waiting でも戻る。hook で終えたものは戻らない
  await reconcileLiveness(store, { now: () => at(3), isAlive: async () => true });
  assert.equal(store.getSession("idle")?.endedReason, "idle");
  observe({ kind: "turn_done", sessionId: "idle", reply: "done" }, stores, at(4));
  assert.equal(store.getSession("idle")?.status, "running");
  await reconcileLiveness(store, { now: () => at(5), isAlive: async () => true });
  observe({ kind: "waiting", sessionId: "idle", reason: "permission" }, stores, at(6));
  assert.equal(store.getSession("idle")?.status, "waiting");
  assert.equal(store.getSession("idle")?.waitingReason, "permission");
  observe({ kind: "turn_start", sessionId: "hooked", prompt: "続き" }, stores, at(6));
  assert.equal(store.getSession("hooked")?.status, "ended");
  assert.equal(store.getSession("hooked")?.endedReason, "explicit");
});
