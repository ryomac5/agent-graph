import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateDelivery } from "../../src/state/index.ts";
import type { Binding, DeliveryEvidence, DeliveryDecision, Operation, Receipt, Tombstone } from "../../src/state/index.ts";
import { checkOrders, scan } from "./helpers.ts";

function op(phase: Operation["phase"], at = 0, extra: Partial<Operation> = {}): Operation {
  return { kind: "operation", id: `${phase}-${at}`, cmdId: "cmd", target: "target-v1", bodyKey: "body", phase, at, observedAt: at, ...extra };
}
function receipt(at = 20, extra: Partial<Receipt> = {}): Receipt {
  return { kind: "receipt", id: `receipt-${at}`, target: "target-v1", inputId: `input-${at}`, bodyKey: "body", phase: "consumed", at, observedAt: at, ...extra };
}
function binding(extra: Partial<Binding> = {}): Binding {
  return { kind: "binding", id: "binding", cmdId: "cmd", target: "target-v1", correlation: { protocol: "codex", id: "native-turn" }, at: 10, observedAt: 10, ...extra };
}
const sent = [op("accepted"), op("emitting", 10), op("emitted", 15)];
const correlated = receipt(20, { id: "correlated-20", correlation: { protocol: "codex", id: "native-turn" } });
function summarize(s: DeliveryDecision) { return { value: s.value, display: s.display, reason: s.reason, confidence: s.confidence, resendAutomatically: s.resendAutomatically }; }
function expected(value: DeliveryDecision["value"], display: DeliveryDecision["display"], reason: DeliveryDecision["reason"], confidence: DeliveryDecision["confidence"] = "unknown") {
  return { value, display, reason, confidence, resendAutomatically: false };
}

export const deliveryCases: { name: string; evidence: DeliveryEvidence[]; now: number; expected: ReturnType<typeof expected> }[] = [
  { name: "no operation record cannot prove delivery", evidence: [], now: 30, expected: expected("unverifiable", "Unconfirmed", "missing_evidence") },
  { name: "accepted is Sending only before fixed deadline", evidence: [op("accepted")], now: 30, expected: expected("accepted", "Sending", "accepted", "confirmed") },
  { name: "hung acceptance becomes Unconfirmed", evidence: [op("accepted")], now: 60_000, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "emitting does not imply receipt", evidence: sent.slice(0, 2), now: 30, expected: expected("emitting", "Sending", "emitting", "confirmed") },
  { name: "emitted does not imply receipt", evidence: sent, now: 30, expected: expected("emitted", "Sending", "emitted", "confirmed") },
  { name: "send call never returns: bound from emitting timestamp", evidence: sent.slice(0, 2), now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "delivery timeout never means Not delivered", evidence: sent, now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "failed receiver scan cannot mean Not delivered", evidence: [...sent, scan(20, { subjects: ["target-v1"], status: "failed", hosted: [], processes: [] })], now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "successful receiver scan with no receipt is still Unconfirmed", evidence: [...sent, scan(20, { subjects: ["target-v1"] })], now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "stop after accept without any write is Not delivered", evidence: [op("accepted"), op("owner_lost", 20)], now: 30, expected: expected("rejected", "Not delivered", "not_emitted", "confirmed") },
  { name: "stop during first write is Unconfirmed", evidence: [...sent.slice(0, 2), op("aborted", 20)], now: 30, expected: expected("unverifiable", "Unconfirmed", "aborted_after_write") },
  { name: "stop after Enter before ack is Unconfirmed", evidence: [...sent, op("owner_lost", 20)], now: 30, expected: expected("unverifiable", "Unconfirmed", "owner_restarted") },
  { name: "explicit rejection stays rejected after external same text", evidence: [op("accepted"), op("rejected", 10), receipt()], now: 30, expected: expected("rejected", "Not delivered", "not_emitted", "confirmed") },
  { name: "claiming rejection after emission is conflicting evidence", evidence: [...sent, op("rejected", 20)], now: 30, expected: expected("unverifiable", "Unconfirmed", "evidence_conflict") },
  { name: "one matching external input has no sender proof", evidence: [...sent, receipt()], now: 30, expected: expected("received_candidate", "Likely delivered", "unique_candidate", "inferred") },
  { name: "two same-text inputs revoke the single candidate", evidence: [...sent, receipt(), receipt(25)], now: 30, expected: expected("unverifiable", "Unconfirmed", "ambiguous_candidates") },
  { name: "correlation promotes previously likely delivery", evidence: [...sent, receipt(), binding(), correlated], now: 30, expected: expected("received", "Delivered", "correlated_receipt", "confirmed") },
  { name: "late correlation promotes Unconfirmed", evidence: [...sent, binding(), { ...correlated, observedAt: 100_000 }], now: 100_001, expected: expected("received", "Delivered", "correlated_receipt", "confirmed") },
  { name: "late candidate promotes Unconfirmed", evidence: [...sent, receipt(20, { observedAt: 100_000 })], now: 100_001, expected: expected("received_candidate", "Likely delivered", "unique_candidate", "inferred") },
  { name: "old text ingested late does not match", evidence: [...sent, receipt(5, { observedAt: 100_000 })], now: 100_001, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "receipt for another target generation cannot match", evidence: [...sent, receipt(20, { target: "target-v2" })], now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "one queue candidate is only Likely queued", evidence: [...sent, receipt(20, { phase: "queued" })], now: 30, expected: expected("received_candidate", "Likely queued", "unique_candidate", "inferred") },
  { name: "same input ID queue then consumption is one input", evidence: [...sent, receipt(20, { phase: "queued", inputId: "input" }), receipt(25, { inputId: "input" })], now: 30, expected: expected("received_candidate", "Likely delivered", "unique_candidate", "inferred") },
  { name: "without shared input ID queue and user remain ambiguous", evidence: [...sent, receipt(20, { phase: "queued" }), receipt(25)], now: 30, expected: expected("unverifiable", "Unconfirmed", "ambiguous_candidates") },
  { name: "correlated queue is Queued", evidence: [...sent, binding(), { ...correlated, phase: "queued" }], now: 30, expected: expected("received", "Queued", "correlated_receipt", "confirmed") },
  { name: "terminal screen is not receiver confirmation", evidence: [...sent, { kind: "terminal", id: "screen", cmdId: "cmd", target: "target-v1", at: 20, observedAt: 20 }], now: 30, expected: expected("terminal_handled", "Handled in terminal", "terminal_handled", "inferred") },
  { name: "terminal-handled can later become Delivered", evidence: [...sent, { kind: "terminal", id: "screen", cmdId: "cmd", target: "target-v1", at: 20, observedAt: 20 }, binding(), correlated], now: 30, expected: expected("received", "Delivered", "correlated_receipt", "confirmed") },
  { name: "unverified SDK UUID roundtrip is not Delivered", evidence: [...sent, binding({ correlation: { protocol: "unverified_sdk", id: "uuid" } }), receipt(20, { bodyKey: undefined, correlation: { protocol: "unverified_sdk", id: "uuid" } })], now: 30, expected: expected("unverifiable", "Unconfirmed", "unsupported_correlation") },
  { name: "unverified peer protocol is not Delivered", evidence: [...sent, binding({ correlation: { protocol: "peer", id: "peer-id" } }), receipt(20, { bodyKey: undefined, correlation: { protocol: "peer", id: "peer-id" } })], now: 30, expected: expected("unverifiable", "Unconfirmed", "unsupported_correlation") },
  { name: "same cmd_id with different body is a conflict", evidence: [...sent, op("accepted", 20, { bodyKey: "different" })], now: 30, expected: expected("unverifiable", "Unconfirmed", "cmd_id_conflict") },
  { name: "same cmd_id with different target is a conflict", evidence: [...sent, op("accepted", 20, { target: "target-v2" })], now: 30, expected: expected("unverifiable", "Unconfirmed", "cmd_id_conflict") },
  { name: "reconnect repeats cmd_id without granting resend", evidence: [...sent, op("accepted", 25), receipt()], now: 30, expected: expected("received_candidate", "Likely delivered", "unique_candidate", "inferred") },
  { name: "duplicate cmd acceptance cannot extend deadline", evidence: [...sent, op("accepted", 60_000)], now: 60_010, expected: expected("unverifiable", "Unconfirmed", "delivery_expired") },
  { name: "one native correlation shared by two commands is unresolved", evidence: [...sent, binding(), binding({ id: "other-binding", cmdId: "other" }), correlated], now: 30, expected: expected("unverifiable", "Unconfirmed", "evidence_conflict") },
];

for (const c of deliveryCases) test(c.name, () => {
  assert.deepEqual(summarize(evaluateDelivery({ cmdId: "cmd", evidence: c.evidence }, c.now)), c.expected);
  checkOrders(c.evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, c.now));
});

test("N5 two same-text sends are both ambiguous regardless of send/receive ordering", () => {
  const evidence = [op("emitting", 10), receipt(20), op("emitting", 30, { cmdId: "second" }), receipt(40)];
  for (const cmdId of ["cmd", "second"]) {
    assert.equal(evaluateDelivery({ cmdId, evidence }, 50).value, "unverifiable");
    checkOrders(evidence, evidence => evaluateDelivery({ cmdId, evidence }, 50));
  }
});

test("two same-text sends can be distinguished by receiver correlations", () => {
  const evidence = [op("emitting", 10), op("emitting", 15, { cmdId: "second" }), binding(), binding({ id: "second-binding", cmdId: "second", correlation: { protocol: "codex", id: "second-turn" } }), correlated,
    receipt(25, { correlation: { protocol: "codex", id: "second-turn" } })];
  for (const cmdId of ["cmd", "second"]) {
    assert.equal(evaluateDelivery({ cmdId, evidence }, 50).value, "received");
    checkOrders(evidence, evidence => evaluateDelivery({ cmdId, evidence }, 50));
  }
});

test("deadline and clock-skew boundaries are explicit", () => {
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence: sent }, 60_009).value, "emitted");
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence: sent }, 60_010).value, "unverifiable");
  const evidence = [...sent, receipt(8)];
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 60_010).value, "unverifiable");
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 60_010, { deadlineMs: 60_000, clockSkewMs: 2 }).value, "received_candidate");
});

test("same text typed at or after the delivery deadline cannot restore Likely delivered", () => {
  for (const at of [60_010, 60_011, 100_000]) {
    const evidence = [...sent, receipt(at)];
    const output = evaluateDelivery({ cmdId: "cmd", evidence }, 100_001);
    assert.equal(output.display, "Unconfirmed"); assert.equal(output.reason, "delivery_expired");
    checkOrders(evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, 100_001));
    assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 100_001, { deadlineMs: 60_000, clockSkewMs: 2 }).display, "Unconfirmed");
  }
  const evidence = [...sent, receipt(60_009, { observedAt: 100_000 })];
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 100_001).display, "Likely delivered");
});

test("each same-text operation has its own bounded candidate window", () => {
  const evidence = [op("emitting", 10), receipt(20), op("emitting", 70_000, { cmdId: "second" }), receipt(70_010)];
  for (const cmdId of ["cmd", "second"]) {
    assert.equal(evaluateDelivery({ cmdId, evidence }, 80_000).display, "Likely delivered");
    checkOrders(evidence, evidence => evaluateDelivery({ cmdId, evidence }, 80_000));
  }
});

test("a queue input received before the deadline can be consumed afterwards", () => {
  const evidence = [...sent, receipt(20, { phase: "queued", inputId: "input" }), receipt(70_000, { inputId: "input" })];
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 80_000).display, "Likely delivered");
  checkOrders(evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, 80_000));
});

test("a late correlated receipt still proves delivery after the candidate window closes", () => {
  const evidence = [...sent, binding(), receipt(100_000, { correlation: { protocol: "codex", id: "native-turn" } })];
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 100_001).display, "Delivered");
  checkOrders(evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, 100_001));
});

test("tombstone survives loss of body and reconnect without new emission", () => {
  for (const value of ["received", "rejected", "unverifiable"] as const) {
    const tombstone: Tombstone = { kind: "tombstone", id: "tombstone", cmdId: "cmd", target: "target-v1", bodyKey: "body", value, at: 10, observedAt: 10 };
    const evidence = [tombstone, op("accepted", 1_000_000)];
    const output = evaluateDelivery({ cmdId: "cmd", evidence }, 1_000_001);
    assert.equal(output.value, value); assert.equal(output.resendAutomatically, false);
    checkOrders(evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, 1_000_001));
  }
});

test("failed scan appears beside existing receipt without revoking it", () => {
  const output = evaluateDelivery({ cmdId: "cmd", evidence: [...sent, receipt(), scan(25, { subjects: ["target-v1"], status: "partial" })] }, 30);
  assert.equal(output.observation, "failed"); assert.equal(output.value, "received_candidate");
});

test("late receiver proof can resolve an Unconfirmed tombstone", () => {
  const tombstone: Tombstone = { kind: "tombstone", id: "tombstone", cmdId: "cmd", target: "target-v1", bodyKey: "body", value: "unverifiable", at: 10, observedAt: 10 };
  const evidence = [tombstone, binding(), correlated];
  assert.equal(evaluateDelivery({ cmdId: "cmd", evidence }, 30).value, "received");
  checkOrders(evidence, evidence => evaluateDelivery({ cmdId: "cmd", evidence }, 30));
});
