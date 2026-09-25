import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { parseAction, performAction } from "../src/actions.ts";
import { TOKEN_HEADER } from "../src/http/contract.ts";
import { startHttpServer } from "../src/http/server.ts";
import { NotFoundError } from "../src/sessions.ts";

const startedAt = "2026-09-25T00:00:00.000Z";
const now = new Date("2026-09-25T01:00:00.000Z");
const repo = "repo-abc123";

function fixture(): { store: Store; stores: Map<string, Store> } {
  const store = openStore(":memory:");
  store.upsertRepo({ key: repo, rootPath: "/repo", name: "repo" });
  store.insertSession({ id: "s1", repoKey: repo, name: "repo-001", client: "planner", traceId: "a".repeat(32), startedAt });
  store.insertGraph({ id: "G1", repoKey: repo, sessionId: "s1", goal: "goal", fingerprint: "f", createdAt: startedAt }, [
    { graphId: "G1", id: "gate", title: "gate", role: "human", dependsOn: [], state: "waiting_human", attempts: 0 },
    { graphId: "G1", id: "merge", title: "merge", role: "implement", dependsOn: [], state: "conflict", attempts: 1 },
    { graphId: "G1", id: "broken", title: "broken", role: "implement", dependsOn: [], state: "failed", attempts: 2 },
    { graphId: "G1", id: "work", title: "work", role: "implement", dependsOn: [], state: "running", attempts: 1 },
  ]);
  store.insertTurn({ id: "t1", sessionId: "s1", at: startedAt, prompt: "hello" });
  return { store, stores: new Map([[repo, store]]) };
}

function decisions(store: Store): { taskId: string; action: string }[] {
  return store.listTaskDecisions("G1").map(({ taskId, action }) => ({ taskId, action }));
}

test("approve と reject は待ちのタスクだけ、retry は failed も task_decisions に記録する", (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  assert.deepEqual(performAction({ action: "approve", repo, graphId: "G1", taskId: "gate" }, stores, now),
    { ok: true, message: "gate を承認した。planner が反映する" });
  assert.equal(performAction({ action: "reject", repo, graphId: "G1", taskId: "merge" }, stores, now).ok, true);
  assert.equal(performAction({ action: "retry", repo, graphId: "G1", taskId: "broken" }, stores, now).ok, true);
  // 状態が合わないときは記録せず ok: false
  const denied = performAction({ action: "approve", repo, graphId: "G1", taskId: "broken" }, stores, now);
  assert.equal(denied.ok, false); assert.match(denied.message, /failed/);
  assert.equal(performAction({ action: "retry", repo, graphId: "G1", taskId: "work" }, stores, now).ok, false);
  assert.deepEqual(decisions(store), [{ taskId: "gate", action: "approve" }, { taskId: "merge", action: "reject" }, { taskId: "broken", action: "retry" }]);
  assert.equal(store.listTaskDecisions("G1")[0].at, now.toISOString());
  // 表は状態を変えない。反映は planner の仕事
  assert.equal(store.getTask("G1", "gate")?.state, "waiting_human");
  // graphId は planner のセッション識別子でも引ける
  assert.equal(performAction({ action: "approve", repo, graphId: "s1", taskId: "gate" }, stores, now).ok, true);
  // 未知の対象は NotFoundError
  assert.throws(() => performAction({ action: "approve", repo, graphId: "G9", taskId: "gate" }, stores), NotFoundError);
  assert.throws(() => performAction({ action: "approve", repo, graphId: "G1", taskId: "nope" }, stores), NotFoundError);
  assert.throws(() => performAction({ action: "approve", repo: "other-000", graphId: "G1", taskId: "gate" }, stores), NotFoundError);
});

test("end_session は状態だけ ended にし、hide_turn は hidden を立てる", (t) => {
  const { store, stores } = fixture();
  t.after(() => store.close());
  store.insertDelegation({ id: "d1", repoKey: repo, sessionId: "s1", role: "implement", title: "d1", status: "running" });
  store.insertDelegation({ id: "d2", repoKey: repo, sessionId: "s1", role: "implement", title: "d2", status: "requested" });
  // 走っている委譲があれば断る。委譲は lost にしない
  const busy = performAction({ action: "end_session", repo, sessionId: "s1" }, stores, now);
  assert.equal(busy.ok, false); assert.match(busy.message, /2 件/);
  assert.equal(store.getSession("s1")?.status, "running");
  assert.equal(store.db.prepare("SELECT status FROM delegations WHERE id = 'd1'").get()?.status, "running");
  store.finishDelegation("d1", "done"); store.finishDelegation("d2", "failed");
  assert.deepEqual(performAction({ action: "end_session", repo, sessionId: "s1" }, stores, now), { ok: true, message: "repo-001 を終了した" });
  const session = store.getSession("s1");
  assert.equal(session?.status, "ended"); assert.equal(session?.endedAt, now.toISOString());
  assert.equal(store.db.prepare("SELECT status FROM delegations WHERE id = 'd1'").get()?.status, "done");
  assert.equal(performAction({ action: "end_session", repo, sessionId: "s1" }, stores, now).ok, false);
  assert.throws(() => performAction({ action: "end_session", repo, sessionId: "s9" }, stores), NotFoundError);

  assert.equal(performAction({ action: "hide_turn", repo, turnId: "t1" }, stores).ok, true);
  assert.equal(store.getTurn("t1")?.hidden, true);
  assert.equal(performAction({ action: "hide_turn", repo, turnId: "t1" }, stores).ok, false);
  assert.throws(() => performAction({ action: "hide_turn", repo, turnId: "t9" }, stores), NotFoundError);
});

test("body と識別子の文字種を検べる", () => {
  assert.throws(() => parseAction(null), TypeError);
  assert.throws(() => parseAction([]), TypeError);
  assert.throws(() => parseAction({ action: "rerun", repo }), /Unknown action/);
  assert.throws(() => parseAction({ action: "approve", repo: "", graphId: "G1", taskId: "gate" }), /Invalid repo/);
  assert.throws(() => parseAction({ action: "approve", repo: "r".repeat(257), graphId: "G1", taskId: "gate" }), /Invalid repo/);
  assert.throws(() => parseAction({ action: "approve", repo: 1, graphId: "G1", taskId: "gate" }), /Invalid repo/);
  assert.throws(() => parseAction({ action: "approve", repo, graphId: "G1" }), /Invalid taskId/);
  assert.throws(() => parseAction({ action: "approve", repo, graphId: "../x", taskId: "gate" }), /Invalid graphId/);
  assert.throws(() => parseAction({ action: "end_session", repo }), /Invalid sessionId/);
  assert.throws(() => parseAction({ action: "hide_turn", repo, turnId: "t;1" }), /Invalid turnId/);
  assert.throws(() => parseAction({ action: "approve", repo, graphId: "G1", taskId: "x".repeat(129) }), /Invalid taskId/);
  assert.deepEqual(parseAction({ action: "approve", repo, graphId: "G1", taskId: "gate", extra: 1 }),
    { action: "approve", repo, graphId: "G1", taskId: "gate" });
  assert.throws(() => performAction({ action: "approve", repo: "unknown-0", graphId: "G1", taskId: "gate" }, new Map()), NotFoundError);
});

test("日本語や空白を含む repo の key でも操作できる", (t) => {
  const key = "作業 領域-abc123";
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key, rootPath: "/作業 領域", name: "作業 領域" });
  store.insertSession({ id: "s1", repoKey: key, name: "作業 領域-001", client: "planner", traceId: "a".repeat(32), startedAt });
  store.insertGraph({ id: "G1", repoKey: key, sessionId: "s1", goal: "goal", fingerprint: "f", createdAt: startedAt },
    [{ graphId: "G1", id: "gate", title: "gate", role: "human", dependsOn: [], state: "waiting_human", attempts: 0 }]);
  const stores = new Map([[key, store]]);
  assert.equal(parseAction({ action: "approve", repo: key, graphId: "G1", taskId: "gate" }).repo, key);
  assert.equal(performAction({ action: "approve", repo: key, graphId: "G1", taskId: "gate" }, stores, now).ok, true);
  assert.equal(performAction({ action: "end_session", repo: key, sessionId: "s1" }, stores, now).ok, true);
  assert.throws(() => performAction({ action: "end_session", repo: "作業領域-abc123", sessionId: "s1" }, stores, now), NotFoundError);
});

function raw(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/api/action", headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
    });
    client.on("error", reject);
    client.end(body);
  });
}

test("POST /api/action はトークン無しを拒み、通れば ActionResult を返す", async (t) => {
  const { store, stores } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-action-"));
  const tokenPath = join(directory, "run", "dashboard.token");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let server;
  try {
    server = await startHttpServer({ port: 0, openStores: stores, listRepos: () => [], tokenPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const token = readFileSync(tokenPath, "utf8").trim();
  const json = { host: `127.0.0.1:${port}`, "content-type": "application/json" };
  const approve = JSON.stringify({ action: "approve", repo, graphId: "G1", taskId: "gate" });

  const missing = await raw(port, json, approve);
  assert.equal(missing.status, 403); assert.match(JSON.parse(missing.body).error, /token/);
  assert.equal((await raw(port, { ...json, [TOKEN_HEADER]: "wrong" }, approve)).status, 403);
  assert.equal(decisions(store).length, 0);

  const ok = await raw(port, { ...json, [TOKEN_HEADER]: token }, approve);
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { ok: true, message: "gate を承認した。planner が反映する" });
  assert.deepEqual(decisions(store), [{ taskId: "gate", action: "approve" }]);

  const denied = await raw(port, { ...json, [TOKEN_HEADER]: token }, JSON.stringify({ action: "approve", repo, graphId: "G1", taskId: "work" }));
  assert.equal(denied.status, 409); assert.equal(JSON.parse(denied.body).ok, false);
  const bad = await raw(port, { ...json, [TOKEN_HEADER]: token }, JSON.stringify({ action: "approve", repo }));
  assert.equal(bad.status, 400); assert.match(JSON.parse(bad.body).error, /graphId/);
  const unknown = await raw(port, { ...json, [TOKEN_HEADER]: token }, JSON.stringify({ action: "end_session", repo, sessionId: "s9" }));
  assert.equal(unknown.status, 404);
  const hidden = await raw(port, { ...json, [TOKEN_HEADER]: token }, JSON.stringify({ action: "hide_turn", repo, turnId: "t1" }));
  assert.equal(hidden.status, 200); assert.equal(store.getTurn("t1")?.hidden, true);
});
