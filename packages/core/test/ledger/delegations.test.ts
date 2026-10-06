import assert from "node:assert/strict";
import test from "node:test";
import type { Fact, FactInput } from "../../src/ledger/facts.ts";
import { projectDelegations } from "../../src/ledger/projections/delegations.ts";

function createFact(input: FactInput, order = 0): Fact {
  return { ...input, seq: 100 - order, fact_id: input.source_event_id, payload_hash: "hash",
    observed_ts: "2030-01-01T00:00:00Z", schema_version: 1, cursor: null, supersedes: input.supersedes ?? null } as Fact;
}
function createRequest(id = "request", subject = "d1", extra = {}): Fact {
  return createFact({ source: "intake", source_event_id: id, kind: "delegation.created", subject: `delegation:${subject}`,
    source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed", payload: {
      request_id: "r1", role: "implementer", title: "Task", task: "Implement", accept: ["tests"], attempt: 1, state: "received", ...extra,
    } });
}
function createState(id: string, attempt: number, state: "failed" | "running" | "done"): Fact {
  return createFact({ source: "intake", source_event_id: id, kind: "delegation.state_changed", subject: "delegation:d1",
    source_ts: `2026-01-0${attempt + 1}T00:00:00Z`, confidence: "confirmed", payload: { attempt, state } });
}

test("同じ requestId の再送と異なる subject は委譲を増やさない", () => {
  const facts = [createRequest(), createRequest("resend", "d2"), createState("running", 1, "running")];
  const result = projectDelegations([...facts, facts[0]]);
  assert.equal(result.length, 1);
  assert.equal(result[0].request_id, "r1");
  assert.deepEqual(result[0].conflicts, []);
  assert.equal(result[0].state, "running");
});

test("同じ requestId の異なる内容は矛盾を記録し依頼を変更しない", () => {
  const result = projectDelegations([createRequest(), createRequest("z-conflict", "d2", { task: "Different", state: "denied" })]);
  assert.equal(result.length, 1);
  assert.equal(result[0].task, "Implement");
  assert.deepEqual(result[0].conflicts, ["z-conflict"]);
  assert.equal(result[0].state, "received");
});

test("試行は実行と割り当てと検証とレビューを積み上げる", () => {
  const attempt = createFact({ source: "intake", source_event_id: "attempt", kind: "delegation.attempt_created",
    subject: "delegation:d1", source_ts: "2026-01-03T01:00:00Z", confidence: "confirmed",
    payload: { attempt: 2, run_id: "run2", assignment: { provider: "codex" }, verification: { passed: true }, review: { accepted: true } } });
  const result = projectDelegations([createRequest(), createState("failure", 1, "failed"), createState("retry", 2, "running"), attempt]);
  assert.equal(result[0].attempt, 2);
  assert.equal(result[0].state, "running");
  assert.equal(result[0].attempts[0].state, "failed");
  assert.deepEqual(result[0].attempts[1], { attempt: 2, state: "running", run_id: "run2", assignment: { provider: "codex" }, verification: { passed: true }, review: { accepted: true } });
});

test("親の実行を優先し、観測済みの起動元だけを確定する", () => {
  const conversation = createFact({ source: "hook", source_event_id: "conversation", kind: "conversation.created", subject: "conversation:c1",
    source_ts: "2026-01-02T00:00:00Z", confidence: "confirmed",
    payload: { provider: "codex", native_id: "native", origin: "observed", type: "interactive", history_format: "jsonl" } });
  const origin = { provider: "codex", native_id: "native" };
  const run = createFact({ source: "host-codex", source_event_id: "parent-run", kind: "run.created", subject: "run:parent",
    source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed",
    payload: { conversation_id: "c1", generation: 1, state: "running" } });
  assert.deepEqual(projectDelegations([createRequest()])[0].parent, { confidence: "unknown" });
  assert.deepEqual(projectDelegations([createRequest("request", "d1", { origin })])[0].parent, { confidence: "unknown" });
  assert.deepEqual(projectDelegations([createRequest("request", "d1", { origin }), conversation])[0].parent, { confidence: "confirmed", conversation_id: "c1" });
  assert.deepEqual(projectDelegations([createRequest("request", "d1", { origin, parent_run_id: "parent" }), conversation])[0].parent, { confidence: "unknown" });
  assert.deepEqual(projectDelegations([createRequest("request", "d1", { origin, parent_run_id: "parent" }), conversation, run])[0].parent, { confidence: "confirmed", run_id: "parent" });
  assert.deepEqual(projectDelegations([{ ...createRequest("request", "d1", { parent_run_id: "guess" }), confidence: "inferred" }])[0].parent, { confidence: "unknown" });
});

test("旧キットの親は台帳の実行が後から届いたときだけ確定する", () => {
  const request: Fact = { ...createRequest("kit-request", "d1", { parent_run_id: "parent" }), source: "kit" };
  const run = createFact({ source: "host-codex", source_event_id: "parent-run", kind: "run.created", subject: "run:parent",
    source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed",
    payload: { conversation_id: "c1", generation: 1, state: "running" } });
  assert.deepEqual(projectDelegations([request])[0].parent, { confidence: "unknown" });
  assert.deepEqual(projectDelegations([request, { ...run, subject: "run:other" }])[0].parent, { confidence: "unknown" });
  assert.deepEqual(projectDelegations([request, run])[0].parent, { confidence: "confirmed", run_id: "parent" });
  assert.deepEqual(projectDelegations([run, request]), projectDelegations([request, run]));
});

test("再送と訂正が共存しても元の依頼で照合し、訂正を反映する", () => {
  const request = createRequest();
  const resend = createRequest("resend", "d2");
  const correction = createFact({ source: "intake", source_event_id: "corr", kind: "delegation.corrected", subject: "delegation:d1",
    source_ts: "2026-01-04T00:00:00Z", confidence: "confirmed", supersedes: "request", payload: { title: "Corrected" } });
  const expected = projectDelegations([request, correction]);
  assert.equal(expected[0].title, "Corrected");
  assert.deepEqual(expected[0].conflicts, []);
  for (const facts of [[request, resend, correction], [resend, correction, request], [correction, request, resend]]) {
    assert.deepEqual(projectDelegations(facts), expected);
  }
  const lateResend = { ...resend, source_ts: "2026-01-05T00:00:00Z" };
  assert.deepEqual(projectDelegations([lateResend, correction, request]), expected);
  const conflict = createRequest("z-conflict", "bad", { title: "Corrected" });
  assert.deepEqual(projectDelegations([request, resend, correction, conflict])[0].conflicts, ["z-conflict"]);
});

test("到着順と seq と受信時刻に依存せず訂正を反映する", () => {
  const facts = [createRequest(), createState("failure", 1, "failed"), createState("retry", 2, "running"),
    createFact({ source: "intake", source_event_id: "correct", kind: "delegation.corrected", subject: "delegation:d1",
      source_ts: "2026-01-04T00:00:00Z", confidence: "confirmed", supersedes: "request", payload: { title: "Corrected" } })];
  const expected = projectDelegations(facts);
  assert.equal(expected[0].title, "Corrected");
  for (let offset = 0; offset < facts.length; offset += 1) {
    const rotated = [...facts.slice(offset), ...facts.slice(0, offset)].reverse().map((fact, index) => ({ ...fact, seq: index, observed_ts: "2040-01-01T00:00:00Z" }));
    assert.deepEqual(projectDelegations(rotated), expected);
  }
  assert.deepEqual(projectDelegations([{ ...createRequest(), payload: null }]), []);
});

test("遅れた再送は状態を戻さず、矛盾した別 subject の更新を適用しない", () => {
  const resend = { ...createRequest("resend", "d2"), source_ts: "2026-01-04T00:00:00Z" };
  const facts = [createRequest(), createState("running", 1, "running"), resend];
  assert.equal(projectDelegations(facts)[0].state, "running");
  const conflict = createRequest("z-conflict", "bad", { task: "Different" });
  const denied = createFact({ source: "intake", source_event_id: "denied", kind: "delegation.state_changed", subject: "delegation:bad",
    source_ts: "2026-01-05T00:00:00Z", confidence: "confirmed", payload: { attempt: 1, state: "denied" } });
  assert.equal(projectDelegations([...facts, conflict, denied])[0].state, "running");
  assert.deepEqual(projectDelegations([...facts, conflict, denied].reverse()), projectDelegations([...facts, conflict, denied]));
});

test("状態の訂正は元の状態の事実を置き換える", () => {
  const failure = createState("failure", 1, "failed");
  const correction = createFact({ source: "intake", source_event_id: "state-correction", kind: "delegation.corrected", subject: "delegation:d1",
    source_ts: "2026-01-03T00:00:00Z", confidence: "confirmed", supersedes: "failure", payload: { state: "done" } });
  assert.equal(projectDelegations([correction, createRequest(), failure])[0].state, "done");
});

test("矛盾した subject の更新は request_id が一致しても状態と試行に混ざらない", () => {
  const conflict = createRequest("z-conflict", "bad", { task: "Different" });
  const facts = [createRequest(), createState("running", 1, "running"), conflict];
  const expected = projectDelegations(facts);
  for (const attempt of [1, 2]) {
    const denied = createFact({ source: "intake", source_event_id: `bad-denied-${attempt}`, kind: "delegation.state_changed",
      subject: "delegation:bad", source_ts: "2026-01-05T00:00:00Z", confidence: "confirmed",
      payload: { request_id: "r1", attempt, state: "denied", result: { rejected: true } } });
    assert.deepEqual(projectDelegations([...facts, denied]), expected);
    assert.deepEqual(projectDelegations([denied, ...facts].reverse()), expected);
  }
});
