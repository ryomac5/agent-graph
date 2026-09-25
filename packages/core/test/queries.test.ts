import assert from "node:assert/strict";
import test from "node:test";
import {
  getRepo, lastActivityAt, latestUsageSamples, listDelegations, listGraphEvents, listGraphs, listRecentTurns, listRepos,
  listSessions,
} from "../src/store/queries.ts";
import { openStore, type Store } from "../src/store/store.ts";

const ts = "2026-09-25T00:00:00.000Z";
const later = "2026-09-25T01:00:00.000Z";
const trace = "a".repeat(32);

function withStore(t: { after: (fn: () => void) => void }): Store {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: "/work/repo", name: "repo" });
  store.upsertRepo({ key: "other", rootPath: "/work/other", name: "other" });
  return store;
}

function event(store: Store, kind: string, at: string, payload: Record<string, unknown>, session = "s1"): void {
  store.appendEvent({ id: `${kind}-${at}-${Math.random()}`, ts: at, kind: kind as never, repo: "r", session,
    trace: { traceId: trace, spanId: "b".repeat(16) }, payload: payload as never });
}

test("リポジトリとセッションの一覧", (t) => {
  const store = withStore(t);
  assert.deepEqual(getRepo(store.db, "r"), { key: "r", rootPath: "/work/repo", name: "repo" });
  assert.equal(getRepo(store.db, "missing"), undefined);
  assert.deepEqual(listRepos(store.db).map((repo) => repo.key), ["other", "r"]);
  store.insertSession({ id: "s2", repoKey: "r", name: "repo-002", client: "codex", traceId: trace, startedAt: later });
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts, model: "opus" });
  store.insertSession({ id: "o1", repoKey: "other", name: "other-001", client: "claude", traceId: trace, startedAt: ts });
  store.setSessionWaiting("s1", "question", later);
  store.setSessionGoalIfEmpty("s1", "契約を固定する");
  const sessions = listSessions(store.db, "r");
  assert.deepEqual(sessions.map((session) => session.id), ["s1", "s2"]);
  assert.equal(sessions[0].status, "waiting");
  assert.equal(sessions[0].waitingReason, "question");
  assert.equal(sessions[0].goal, "契約を固定する");
  assert.equal(sessions[0].model, "opus");
  assert.equal(sessions[1].endedAt, undefined);
});

test("turn は直近 limit 件を時系列で返す", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  for (let index = 0; index < 5; index++) {
    store.insertTurn({ id: `t${index}`, sessionId: "s1", at: `2026-09-25T00:0${index}:00.000Z`, prompt: `p${index}` });
  }
  store.finishTurn("s1", later, "要約", "返答", () => "unused");
  store.setTurnHidden("t1", true);
  const turns = listRecentTurns(store.db, "s1", 3);
  assert.deepEqual(turns.map((turn) => turn.id), ["t2", "t3", "t4"]);
  assert.equal(turns[2].summary, "要約");
  assert.equal(turns[2].reply, "返答");
  assert.equal(listRecentTurns(store.db, "s1", 10).find((turn) => turn.id === "t1")?.hidden, true);
});

test("委譲は割り当て、受け入れ、レビュー、トークン、時刻、依頼文を合わせて返す", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "s1", role: "implement", title: "実装", status: "done" });
  store.insertAssignment("d1", { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "high",
    reason: ["implement は codex"], policyVersion: "v1" });
  store.insertAcceptance("d1", { passed: false, results: [{ command: "npm test", exitCode: 1, output: "x", durationMs: 5 }],
    scopeViolations: ["README.md"] });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "s1", parentId: "d1", role: "review", title: "Review: 実装",
    status: "done", kind: "subagent" });
  store.insertAssignment("d2", { executor: "claude", model: "fable", family: "anthropic", tier: "high", reason: [], policyVersion: "v1" });
  store.insertReview("d1", "d2", "request_changes", "直して\nVERDICT: request_changes");
  store.insertTokenUsage("d1", { inputTokens: 10, outputTokens: 5 }, "gpt-6-sol");
  store.insertTokenUsage("d1", { inputTokens: 1, outputTokens: 1 }, "gpt-6-sol");
  store.db.prepare("UPDATE delegations SET round_trips = 2, task_id = 'T1' WHERE id = 'd1'").run();
  event(store, "delegation.requested", ts, { delegationId: "d1", task: "依頼の本文" });
  event(store, "delegation.finished", later, { delegationId: "d1", status: "done" });
  store.insertSpan({ trace: { traceId: trace, spanId: "c".repeat(16) }, name: "delegate", startedAt: later, status: "ok",
    attributes: { "agent.role": "review", "agent.executor": "claude", "agent.model": "fable", "agent.session": "s1", "agent.delegation": "d2" } });
  store.insertDelegation({ id: "o", repoKey: "other", sessionId: "s1", role: "implement", title: "別", status: "running" });

  const rows = listDelegations(store.db, "r");
  assert.deepEqual(rows.map((row) => row.id), ["d1", "d2"]);
  const [first, second] = rows;
  assert.equal(first.kind, "delegation");
  assert.equal(first.taskId, "T1");
  assert.equal(first.roundTrips, 2);
  assert.deepEqual(first.assignment, { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "high",
    reason: ["implement は codex"], policyVersion: "v1" });
  assert.equal(first.acceptance?.passed, false);
  assert.deepEqual(first.acceptance?.scopeViolations, ["README.md"]);
  assert.equal(first.acceptance?.results[0].command, "npm test");
  assert.deepEqual(first.review, { verdict: "request_changes", comment: "直して\nVERDICT: request_changes", reviewerDelegationId: "d2" });
  assert.deepEqual(first.tokens, { input: 11, output: 6 });
  assert.equal(first.requestedAt, ts);
  assert.equal(first.finishedAt, later);
  assert.equal(first.task, "依頼の本文");
  assert.equal(first.reviewOutput, undefined);
  assert.equal(second.kind, "subagent");
  assert.equal(second.parentId, "d1");
  assert.equal(second.reviewOutput, "直して\nVERDICT: request_changes");
  // 出来事が無ければ span の開始時刻を使う
  assert.equal(second.requestedAt, later);
  assert.equal(second.finishedAt, undefined);
  assert.equal(second.tokens, undefined);
});

test("planner のグラフとタスクと出来事", (t) => {
  const store = withStore(t);
  store.insertSession({ id: "p1", repoKey: "r", name: "p1", client: "planner", traceId: trace, startedAt: ts });
  const graph = { id: "g1", repoKey: "r", sessionId: "p1", goal: "作る", fingerprint: "f", createdAt: ts };
  store.insertGraph(graph, [
    { graphId: "g1", id: "A", title: "土台", role: "implement", dependsOn: [], state: "done", attempts: 1 },
    { graphId: "g1", id: "B", title: "画面", role: "document", dependsOn: ["A"], state: "verifying", attempts: 2 },
  ]);
  store.appendGraphEvent(graph, "task.result", { taskId: "A", delegationId: "d1", output: "できた" });
  store.appendGraphEvent(graph, "task.integrated", { taskId: "A", conflict: false, files: ["a.ts"] });
  store.appendGraphEvent(graph, "initialized", { baseBranch: "main" });
  const graphs = listGraphs(store.db, "r");
  assert.equal(graphs.length, 1);
  assert.equal(graphs[0].sessionId, "p1");
  assert.deepEqual(graphs[0].tasks.map((task) => [task.id, task.state, task.attempts, task.dependsOn]),
    [["A", "done", 1, []], ["B", "verifying", 2, ["A"]]]);
  const events = listGraphEvents(store.db, "g1");
  assert.deepEqual(events.map((item) => [item.kind, item.taskId]),
    [["task.result", "A"], ["task.integrated", "A"], ["initialized", undefined]]);
  assert.equal(events[0].payload.output, "できた");
  assert.deepEqual(listGraphs(store.db, "other"), []);
});

test("利用枠の最新と最後の動き", (t) => {
  const store = withStore(t);
  store.appendUsageSample({ ts, provider: "anthropic", window: "5h", percent: 10 });
  store.appendUsageSample({ ts: later, provider: "anthropic", window: "5h", percent: 42, resetsAt: later });
  store.appendUsageSample({ ts, provider: "openai", window: "300m", percent: 7 });
  store.appendUsageSample({ ts, provider: "anthropic", window: "7d", percent: 3, model: "Opus" });
  const samples = latestUsageSamples(store.db);
  assert.deepEqual(samples.map((sample) => [sample.provider, sample.window, sample.percent, sample.model]),
    [["anthropic", "5h", 42, undefined], ["anthropic", "7d", 3, "Opus"], ["openai", "300m", 7, undefined]]);
  assert.equal(samples[0].resetsAt, later);

  assert.equal(lastActivityAt(store.db, "r"), undefined);
  store.insertSession({ id: "s1", repoKey: "r", name: "repo-001", client: "claude", traceId: trace, startedAt: ts });
  assert.equal(lastActivityAt(store.db, "r"), ts);
  store.insertTurn({ id: "t1", sessionId: "s1", at: later, prompt: "p" });
  assert.equal(lastActivityAt(store.db, "r"), later);
  event(store, "delegation.requested", "2026-09-25T02:00:00.000Z", { delegationId: "d", task: "x" });
  assert.equal(lastActivityAt(store.db, "r"), "2026-09-25T02:00:00.000Z");
  event(store, "usage.sampled", "2026-09-26T02:00:00.000Z", { provider: "openai", window: "300m", percent: 1 });
  assert.equal(lastActivityAt(store.db, "r"), "2026-09-25T02:00:00.000Z");
  assert.equal(lastActivityAt(store.db, "other"), undefined);
});
