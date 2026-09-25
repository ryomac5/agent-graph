import assert from "node:assert/strict";
import test from "node:test";
import { openStore, type Store } from "../src/store/store.ts";

const ts = "2026-09-25T00:00:00.000Z";
const later = "2026-09-25T01:00:00.000Z";

function withStore(t: { after: (fn: () => void) => void }): Store {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: "/work/repo", name: "repo" });
  store.upsertRepo({ key: "other", rootPath: "/work/other", name: "other" });
  return store;
}

test("初回登録はリポジトリごとの連番で名前を振り、同じ id の再登録では変えない", (t) => {
  const store = withStore(t);
  const base = { client: "claude", traceId: "a".repeat(32), startedAt: ts };
  assert.equal(store.insertNamedSession({ id: "s1", repoKey: "r", ...base }), "repo-001");
  assert.equal(store.insertNamedSession({ id: "s2", repoKey: "r", ...base }), "repo-002");
  assert.equal(store.insertNamedSession({ id: "o1", repoKey: "other", ...base }), "other-001");
  // 手で入れた大きな番号や別形式の名前があっても、最大の次を使う
  store.insertSession({ id: "manual", repoKey: "r", name: "repo-010", ...base });
  store.insertSession({ id: "planner", repoKey: "r", name: "planner-session", ...base });
  assert.equal(store.nextSessionName("r"), "repo-011");
  assert.throws(() => store.insertNamedSession({ id: "s1", repoKey: "r", ...base }));
  assert.equal(store.getSession("s1")?.name, "repo-001");
  assert.equal(store.getSession("s1")?.status, "running");
  assert.equal(store.getSession("s1")?.lastSeenAt, ts);
  assert.throws(() => store.nextSessionName("missing"), /Repository not found/);
});

test("終了は status と ended_at を記録し、走っていた委譲を lost にする", (t) => {
  const store = withStore(t);
  const base = { client: "claude", traceId: "a".repeat(32), startedAt: ts };
  store.insertNamedSession({ id: "s1", repoKey: "r", ...base });
  store.insertNamedSession({ id: "s2", repoKey: "r", ...base });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "running", status: "running" });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", role: "implement", title: "done", status: "done" });
  store.insertDelegation({ id: "d3", repoKey: "r", sessionId: "s2", role: "implement", title: "other", status: "requested" });
  let notified = 0;
  store.onChange(() => { notified++; });
  assert.equal(store.endSession("s1", later), true);
  assert.equal(store.endSession("s1", "2026-09-25T02:00:00.000Z"), false);
  assert.equal(store.endSession("missing", later), false);
  assert.equal(notified, 1);
  const session = store.getSession("s1")!;
  assert.equal(session.status, "ended");
  assert.equal(session.endedAt, later);
  const status = (id: string) => store.db.prepare("SELECT status FROM delegations WHERE id = ?").get(id)!.status;
  assert.equal(status("d1"), "lost");
  assert.equal(status("d2"), "done");
  assert.equal(status("d3"), "requested");
  assert.deepEqual(store.listLiveSessions().map((row) => row.id), ["s2"]);
  // 終わったセッションは観測や待ちで戻らない
  store.touchSession("s1", later);
  store.setSessionWaiting("s1", "permission", later);
  store.setSessionProcess("s1", 1, undefined, later);
  assert.equal(store.getSession("s1")?.status, "ended");
  // 再登録だけが running に戻す。名前は変えず、lost の委譲は戻さない
  const resumedAt = "2026-09-25T03:00:00.000Z";
  assert.equal(store.resumeSession("s1", resumedAt), true);
  assert.equal(store.resumeSession("s1", resumedAt), false);
  assert.equal(store.resumeSession("missing", resumedAt), false);
  const resumed = store.getSession("s1")!;
  assert.equal(resumed.status, "running");
  assert.equal(resumed.endedAt, undefined);
  assert.equal(resumed.lastSeenAt, resumedAt);
  assert.equal(resumed.name, "repo-001");
  assert.equal(status("d1"), "lost");
  assert.deepEqual(store.listLiveSessions().map((row) => row.id), ["s1", "s2"]);
});

test("待ちの設定と解除、pid と goal と model の記録", (t) => {
  const store = withStore(t);
  store.insertNamedSession({ id: "s1", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts });
  store.setSessionWaiting("s1", "permission", later);
  let session = store.getSession("s1")!;
  assert.equal(session.status, "waiting");
  assert.equal(session.waitingReason, "permission");
  assert.equal(session.lastSeenAt, later);
  assert.deepEqual(store.listLiveSessions().map((row) => row.id), ["s1"]);
  store.touchSession("s1", "2026-09-25T02:00:00.000Z");
  session = store.getSession("s1")!;
  assert.equal(session.status, "running");
  assert.equal(session.waitingReason, undefined);
  assert.equal(session.lastSeenAt, "2026-09-25T02:00:00.000Z");
  store.setSessionProcess("s1", 4242, "Thu Sep 25 00:00:00 2026", later);
  store.setSessionModel("s1", "fable");
  store.setSessionGoalIfEmpty("s1", "first");
  store.setSessionGoalIfEmpty("s1", "second");
  session = store.getSession("s1")!;
  assert.equal(session.pid, 4242);
  assert.equal(session.pidStartedAt, "Thu Sep 25 00:00:00 2026");
  assert.equal(session.model, "fable");
  assert.equal(session.goal, "first");
});

test("turn は開始で作り、応答で直近の未完の turn に要約を付け、無ければ新しく作る", (t) => {
  const store = withStore(t);
  store.insertNamedSession({ id: "s1", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts });
  store.insertTurn({ id: "t1", sessionId: "s1", at: ts, prompt: "first" });
  assert.equal(store.finishTurn("s1", later, "summary", "reply", () => "unused"), "t1");
  assert.equal(store.finishTurn("s1", later, "orphan", "reply", () => "t2"), "t2");
  store.setTurnHidden("t1", true);
  assert.deepEqual(store.listTurns("s1"), [
    { id: "t1", sessionId: "s1", at: ts, prompt: "first", summary: "summary", reply: "reply", hidden: true },
    { id: "t2", sessionId: "s1", at: later, prompt: "", summary: "orphan", reply: "reply", hidden: false },
  ]);
  assert.deepEqual(store.listTurns("s1", 1).map((turn) => turn.id), ["t2"]);
  assert.throws(() => store.insertTurn({ id: "t3", sessionId: "missing", at: ts, prompt: "" }));
});

test("委譲の kind と planner の判断の表", (t) => {
  const store = withStore(t);
  store.insertNamedSession({ id: "s1", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "mcp", status: "running" });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", role: "research", title: "agent", status: "running", kind: "subagent" });
  const kinds = store.db.prepare("SELECT id, kind FROM delegations ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(kinds, [{ id: "d1", kind: "delegation" }, { id: "d2", kind: "subagent" }]);
  assert.throws(() => store.insertDelegation({ id: "d3", repoKey: "r", sessionId: "s1", role: "implement", title: "x",
    status: "running", kind: "other" as "subagent" }));
  store.insertTaskDecision("g1", "T1", "approve", ts);
  assert.deepEqual(store.db.prepare("SELECT * FROM task_decisions").all().map((row) => ({ ...row })),
    [{ graph_id: "g1", task_id: "T1", action: "approve", at: ts }]);
});
