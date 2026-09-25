import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../src/store/store.ts";
import { aggregatePerformance } from "../src/store/performance.ts";

test("役割とモデルごとに受け入れ、レビュー、往復、トークンを集計する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "repo", rootPath: "/tmp/repo", name: "repo" });
  store.insertSession({ id: "session", repoKey: "repo", name: "repo-1", client: "codex",
    traceId: "1".repeat(32), startedAt: "2026-09-25T00:00:00Z" });
  const assignment = { executor: "codex" as const, model: "model", family: "openai" as const,
    tier: "mid" as const, reason: [], policyVersion: "1" };
  for (const [id, passed, verdict, tokens] of [["a", true, "approve", 100],
    ["b", false, "request_changes", 300]] as const) {
    store.insertDelegation({ id, repoKey: "repo", sessionId: "session", role: "implement", title: id, status: "done" });
    store.insertAssignment(id, assignment);
    store.insertAcceptance(id, { passed, results: [], scopeViolations: [] });
    store.insertTokenUsage(id, { inputTokens: tokens, outputTokens: tokens }, "model");
  }
  store.db.prepare("UPDATE delegations SET round_trips = 2 WHERE id = 'b'").run();
  store.insertReview("a", "b", "approve", "ok");
  store.insertReview("b", "a", "request_changes", "fix");
  assert.deepEqual(aggregatePerformance(store.db), [{ role: "implement", model: "model",
    samples: 2, acceptRate: 0.5, reviewApprove: 0.5, avgRoundTrips: 1, avgTokens: 400 }]);
  assert.deepEqual(aggregatePerformance(store.db, { role: "review" }), []);
});
