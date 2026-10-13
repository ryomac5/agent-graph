import test from "node:test";
import assert from "node:assert/strict";
import { defaultPolicy, getCandidates, mergePolicy } from "../../core/src/assign/policy.ts";
import { buildPolicyPreview, POLICY_HISTORY_LIMIT, type PastDelegation } from "../src/settings/policy-preview.ts";

function createPast(index: number, role: PastDelegation["request"]["role"] = "implement"): PastDelegation {
  return { id: `internal:${index}`, timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    request: { role, title: `Request ${index}`, task: `Task ${index}`, accept: [] },
    context: { quota: () => undefined, performance: () => undefined } };
}
test("counts assignment changes without counting changed reasons or policy versions, and caps recent examples", () => {
  const before = defaultPolicy();
  const after = mergePolicy(before, { roles: { implement: [...getCandidates(before, "implement")].reverse() } });
  const past = Array.from({ length: POLICY_HISTORY_LIMIT + 10 }, (_, index) => createPast(index, index % 10 === 0 ? "research" : "implement"));
  const preview = buildPolicyPreview("token", before, after, past);
  assert.equal(preview.total, POLICY_HISTORY_LIMIT);
  assert.equal(preview.changed, 90);
  assert.equal(preview.rows.length, 5);
  assert.deepEqual(preview.rows.map(row => row.id), [109, 108, 107, 106, 105].map(index => `internal:${index}`));
  assert.deepEqual(preview.roleChanges.map(change => change.role), ["implement"]);
  assert.deepEqual(preview.roleChanges[0].bands.map(band => band.weight), ["standard"]);
  assert.equal(preview.rows[0].description, "Request 109");
  assert.equal(preview.rows[0].timestamp, past[109].timestamp);
  assert.ok(preview.rows.every(row => row.role === "implement"));
  assert.ok(!JSON.stringify(preview.rows).includes("policyVersion"));
  assert.ok(!JSON.stringify(preview.rows).includes("stage 1"));
});
test("a rules-only edit with identical outcomes and empty history report zero past changes", () => {
  const before = defaultPolicy();
  const after = mergePolicy(before, { quota: { hardLimitPercent: 95 } });
  const preview = buildPolicyPreview("token", before, after, [createPast(0)]);
  assert.equal(preview.total, 1);
  assert.equal(preview.changed, 0);
  assert.deepEqual(preview.rows, []);
  assert.deepEqual(preview.roleChanges, []);
  const empty = buildPolicyPreview("token", before, after, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.changed, 0);
});
test("effort and availability changes count, but two unavailable outcomes do not", () => {
  const before = defaultPolicy();
  const next = getCandidates(before, "implement").map(candidate => ({ ...candidate, effort: "max" }));
  const effort = buildPolicyPreview("token", before, mergePolicy(before, { roles: { implement: next } }), [createPast(0)]);
  assert.equal(effort.changed, 1);
  const unavailable = mergePolicy(before, { roles: { implement: { standard: [] } } });
  assert.equal(buildPolicyPreview("token", before, unavailable, [createPast(0)]).changed, 1);
  assert.equal(buildPolicyPreview("token", unavailable, mergePolicy(unavailable, { maxRoundTrips: 3 }), [createPast(0)]).changed, 0);
});
test("descriptions fall back to task, whitespace is collapsed, and equivalent timestamps sort by time", () => {
  const before = defaultPolicy();
  const after = mergePolicy(before, { roles: { implement: [...getCandidates(before, "implement")].reverse() } });
  const first = createPast(1); first.request.title = ""; first.request.task = "Improve\n  preview"; first.timestamp = "2026-10-01T10:00:00+09:00";
  const second = createPast(2); second.description = "Readable description"; second.timestamp = "2026-10-01T02:00:00Z";
  const empty = createPast(0); empty.description = "";
  const preview = buildPolicyPreview("token", before, after, [first, second, empty]);
  assert.deepEqual(preview.rows.map(row => row.description), ["Readable description", "Improve preview", ""]);
});
