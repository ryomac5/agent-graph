import assert from "node:assert/strict";
import test from "node:test";
import { childContext, openStore, runDelegation, type DelegationDeps, type DelegateRequest } from "../src/index.ts";

const caller = { repoKey: "repo", repoRoot: process.cwd(), sessionId: "session" };
const request: DelegateRequest = { role: "research", title: "調査", task: "調べる", accept: ["true"] };

function setup(t: { after: (fn: () => void) => void }): DelegationDeps {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "repo", rootPath: caller.repoRoot, name: "repo" });
  store.insertSession({ id: "session", repoKey: "repo", name: "repo-1", client: "codex",
    traceId: "1".repeat(32), startedAt: new Date().toISOString() });
  return { store,
    execute: async (req) => ({ exitCode: 0, output: "完了", timedOut: false,
      usage: { inputTokens: 2, outputTokens: 3 }, durationMs: 1, childTrace: childContext(req.trace) }),
    accept: async () => ({ passed: true, results: [], scopeViolations: [] }),
  };
}

test("正常系は各段階を順に記録して span を閉じる", async (t) => {
  const deps = setup(t);
  const result = await runDelegation(request, caller, deps);
  assert.equal(result.status, "done");
  assert.deepEqual(deps.store.listEvents().map((event) => event.kind), [
    "delegation.requested", "assignment.decided", "execution.started", "execution.finished",
    "acceptance.evaluated", "delegation.finished",
  ]);
  const span = deps.store.db.prepare("SELECT * FROM spans WHERE span_id = ?").get(result.spanId)!;
  assert.equal(span.name, "delegate");
  assert.equal(span.status, "ok");
  assert.ok(span.ended_at);
  assert.deepEqual(JSON.parse(span.attributes as string)["agent.executor"], result.assignment.executor);
  assert.deepEqual(JSON.parse(span.attributes as string)["agent.model"], result.assignment.model);
  for (const table of ["delegations", "assignments", "acceptances", "token_usage"]) {
    assert.equal(deps.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 1);
  }
});

test("denied、timeout、受け入れ不合格を返す", async (t) => {
  const deps = setup(t);
  const denied = await runDelegation({ ...request, constraints: { excludeFamily: ["anthropic", "openai"] } }, caller, deps);
  assert.equal(denied.status, "denied");
  deps.execute = async (req) => ({ exitCode: 124, output: "", timedOut: true,
    usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1, childTrace: childContext(req.trace) });
  assert.equal((await runDelegation(request, caller, deps)).status, "timeout");
  deps.execute = async (req) => ({ exitCode: 0, output: "完了", timedOut: false,
    usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, childTrace: childContext(req.trace) });
  deps.accept = async () => ({ passed: false, results: [], scopeViolations: ["other.txt"] });
  assert.equal((await runDelegation(request, caller, deps)).status, "failed");
});

for (const verdict of ["approve", "request_changes"] as const) {
  test(`implement の review は別系統に割り当てられ ${verdict} を反映する`, async (t) => {
    const deps = setup(t);
    const executors: string[] = [];
    deps.execute = async (req) => {
      executors.push(req.executor);
      return { exitCode: 0, output: req.task.includes("元の依頼:") ? `確認\nVERDICT: ${verdict}` : "実装完了",
        timedOut: false, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
        childTrace: childContext(req.trace) };
    };
    const result = await runDelegation({ ...request, role: "implement" }, caller, deps);
    assert.equal(result.status, verdict === "approve" ? "done" : "failed");
    assert.equal(result.review?.verdict, verdict);
    assert.equal(result.assignment.family, "openai");
    assert.equal(result.review?.reviewer.family, "anthropic");
    assert.deepEqual(executors, ["codex", "claude"]);
    const review = deps.store.db.prepare("SELECT * FROM reviews").get()!;
    const child = deps.store.db.prepare("SELECT parent_id FROM delegations WHERE id = ?")
      .get(review.reviewer_delegation_id as string)!;
    assert.equal(child.parent_id, result.delegationId);
    assert.equal(result.roundTrips, 0);
    const parentEvents = deps.store.listEvents().filter((event) =>
      "delegationId" in event.payload && event.payload.delegationId === result.delegationId);
    assert.deepEqual(parentEvents.map((event) => event.kind).slice(-3), [
      "acceptance.evaluated", "review.evaluated", "delegation.finished",
    ]);
  });
}

test("execute の例外でも委譲を failed で閉じる", async (t) => {
  const deps = setup(t);
  deps.execute = async () => { throw new Error("execute failed"); };
  await assert.rejects(runDelegation(request, caller, deps), /execute failed/);
  assert.equal(deps.store.db.prepare("SELECT status FROM delegations").get()!.status, "failed");
  assert.equal(deps.store.listEvents().at(-1)!.kind, "delegation.finished");
  assert.equal(deps.store.db.prepare("SELECT status FROM spans").get()!.status, "error");
});

test("caller.trace を渡すと traceId と親 span を引き継ぐ", async (t) => {
  const deps = setup(t);
  const parent = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
  const result = await runDelegation(request, { ...caller, trace: parent }, deps);
  assert.equal(result.traceId, parent.traceId);
  const span = deps.store.db.prepare("SELECT parent_span_id FROM spans WHERE span_id = ?")
    .get(result.spanId)!;
  assert.equal(span.parent_span_id, parent.spanId);
});
