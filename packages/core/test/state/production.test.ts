import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateDelivery, evaluateState, readNativeEvidence, readNativeTurnId } from "../../src/state/index.ts";
import type { DeliveryEvidence, NativeRecord, StateEvidence, StateInput } from "../../src/state/index.ts";
import { checkOrders, expectedState, PROCESS, scan, stateInput, summarizeState } from "./helpers.ts";
import type { StateSummary } from "./helpers.ts";

interface Sample { line: number; row: Record<string, unknown> & { timestamp: string; promptId?: string; message?: Record<string, unknown>; toolUseResult?: Record<string, unknown> } }
interface Fact { seq: number; source: string; kind: string; source_ts: string; observed_ts: string; payload: { generation?: number; transcript_flags?: Record<string, boolean>; count?: number; last_evidence?: { kind?: string; checked_ts?: string; input?: Record<string, unknown> } } }
interface Production {
  extractedAt: string; facts: Fact[];
  E1: { parent: Sample[]; child: Sample[]; lineCount: number; lastDescendsFromFirst: boolean };
  E2: { watches: { id: string; bodyKey: string; sent_ts: string; failed_ts: string; state: string; normalizationMatched: boolean; receiverCmdIdPresent: boolean }[]; receipts: Sample[] };
  E3: { rows: Sample[] }; E4: { rows: Sample[] }; E5: { rejectedAppends: number; locationsAvailable: boolean };
  E6: { rows: Sample[]; lineCount: number; terminalCount: number }; supplemental: Sample[]; synchronous: Sample[];
  synchronousChild: Sample & { parentPromptMatches: boolean };
}
const production = JSON.parse(readFileSync(new URL("./fixtures/production.json", import.meta.url), "utf8")) as Production;
const now = Date.parse("2026-10-15T07:20:56.288Z");
function native(sample: Sample, source: NativeRecord["source"] = "claude", extra: Partial<NativeRecord> = {}) {
  return readNativeEvidence({ id: `line-${sample.line}`, source, row: sample.row, runId: "run", at: Date.parse(sample.row.timestamp), observedAt: Date.parse(sample.row.timestamp), ...extra });
}
function fact(seq: number): Fact { return production.facts.find(f => f.seq === seq)!; }

const childTurn = production.E1.child[0].row.promptId!;
const childEvidence = [
  ...native(production.E1.child[0]),
  ...native(production.E1.child[1], "claude", { turnId: childTurn }),
  ...native(production.E1.parent[1], "claude_child", { parentCall: production.E1.parent[0].row,
    childId: String(production.E1.parent[1].row.toolUseResult!.agentId), attemptId: "child-attempt" }),
];
const splitEvidence = [301164, 301165, 301179, 301180].flatMap(seq => {
  const f = fact(seq);
  return readNativeEvidence({ id: `seq-${seq}`, at: Date.parse(f.source_ts), observedAt: Date.parse(f.observed_ts),
    source: "hook", row: f.payload.last_evidence!.input!, runId: "hook-run" });
});
const codexTurn = readNativeTurnId("codex", production.E6.rows[0].row)!;
const codexEvidence: StateEvidence[] = [
  ...production.E6.rows.flatMap(row => native(row, "codex")),
  // 旧 process_absent は走査の成否・範囲を失っている。成功した走査に捏造しない。
  { kind: "unavailable", id: "seq-259872", runId: "run", at: Date.parse(fact(259872).source_ts), observedAt: Date.parse(fact(259872).observed_ts) },
];

export const productionCases: { name: string; input: StateInput; now: number; expected: StateSummary }[] = [
  { name: "E1: 29h-old child tool_use is Unknown, launch is incomplete", now,
    input: stateInput(childEvidence, { turnId: childTurn, attempt: { id: "child-attempt", requiredStage: "reported" } }),
    expected: expectedState({ closure: "open", result: "incomplete", stage: "launched", turnReason: "progress_expired" }) },
  { name: "E3: two native runs remain Unresolved", now,
    input: stateInput([...splitEvidence, ...production.E3.rows.flatMap(row => native(row, "claude", { runId: "transcript-run" }))], { runId: null, turnId: null }),
    expected: expectedState({ label: "Unresolved", turnReason: "identity_unresolved" }) },
  { name: "E4: compact summary supplies no turn evidence", now,
    input: stateInput(native(production.E4.rows[0])), expected: expectedState() },
  { name: "E5: unknown conflict locations leave Unknown and a conflict notice", now,
    input: stateInput([{ kind: "conflict", id: "seq-301024", runId: "run", at: Date.parse(fact(301024).source_ts), observedAt: Date.parse(fact(301024).observed_ts), count: fact(301024).payload.count! }]), expected: expectedState() },
  { name: "E6: no task_complete, historical process_absent does not finish turn", now,
    input: stateInput(codexEvidence, { turnId: codexTurn }), expected: expectedState({ closure: "open", turnReason: "progress_expired" }) },
  { name: "E6: at old absence timestamp fresh turn is Working with liveness unverified", now: Date.parse(fact(259872).source_ts),
    input: stateInput(codexEvidence, { turnId: codexTurn }), expected: expectedState({ closure: "open", turn: "running", label: "Working", turnReason: "turn_progress", turnConfidence: "confirmed" }) },
];

for (const c of productionCases) test(c.name, () => {
  assert.deepEqual(summarizeState(evaluateState(c.input, c.now)), c.expected);
  checkOrders(c.input.evidence, evidence => evaluateState({ ...c.input, evidence }, c.now));
});

test("E1: fresh current-parent scan cannot revive a child from a previous process incarnation", () => {
  // 原記録にない PID・procStart は合成条件。E1 の子の時刻と未完了 Bash は実物を使う。
  const evidence = [...childEvidence, scan(now)];
  const target = { ...productionCases[0].input, evidence, process: PROCESS,
    parentProcessAtLaunch: { pid: 40, procStart: "E1-launch-parent" } };
  assert.ok(now - childEvidence[0].at > 31 * 60 * 60 * 1000);
  const output = evaluateState(target, now);
  assert.equal(output.process.value, "unverified"); assert.equal(output.process.reason, "owner_restarted");
  assert.equal(output.display.label, "Unknown"); assert.equal(output.turn.reason, "progress_expired");
  assert.equal(output.display.details.includes("running tool"), false);
  assert.equal(output.result.value, "incomplete"); assert.equal(output.result.stage, "launched");
  checkOrders(evidence, evidence => evaluateState({ ...target, evidence }, now));

});

test("E1: same launch parent without a terminal notification keeps a running child Working", () => {
  const sameParent = evaluateState({ ...productionCases[0].input, evidence: [...childEvidence, scan(now)],
    process: PROCESS, parentProcessAtLaunch: { ...PROCESS } }, now);
  assert.equal(sameParent.process.value, "alive_confirmed");
  assert.equal(sameParent.display.label, "Working"); assert.equal(sameParent.turn.reason, "running_tool");
  assert.ok(sameParent.display.details.includes("running tool"));
});

const childId = String(production.E1.parent[1].row.toolUseResult!.agentId);
const stoppedNotice = production.E1.parent.find(sample => sample.line === 12153)!;

test("E1: actual stopped notification clears Working even with the same live parent", () => {
  const terminal = native(stoppedNotice, "claude_child", { childId, turnId: childTurn, attemptId: "child-attempt" });
  assert.deepEqual(terminal.map(e => e.kind === "signal" ? e.event : e.kind), ["complete", "interrupted"]);
  const evidence = [...childEvidence, ...terminal, scan(now)];
  const target = { ...productionCases[0].input, evidence, process: PROCESS, parentProcessAtLaunch: { ...PROCESS } };
  const output = evaluateState(target, now);
  assert.equal(output.process.value, "alive_confirmed");
  assert.equal(output.turn.value, "unknown"); assert.equal(output.turn.reason, "boundary_unavailable");
  assert.equal(output.display.label, "Unknown"); assert.equal(output.display.details.includes("running tool"), false);
  assert.equal(output.result.stage, "launched"); assert.equal(output.result.value, "incomplete");
  assert.ok(output.turn.evidenceIds.includes("line-12153:complete"));
  checkOrders(evidence, evidence => evaluateState({ ...target, evidence }, now));
});

test("E1: omitted launch identity cannot borrow a live parent's scan", () => {
  const { parentProcessAtLaunch, ...target } = { ...productionCases[0].input,
    evidence: [...childEvidence, scan(now)], process: PROCESS };
  assert.equal(Object.hasOwn(target, "parentProcessAtLaunch"), false);
  const output = evaluateState(target, now);
  assert.equal(output.process.value, "unverified"); assert.equal(output.process.reason, "missing_evidence");
  assert.equal(output.display.label, "Unknown"); assert.equal(output.turn.reason, "progress_expired");
  checkOrders(target.evidence, evidence => evaluateState({ ...target, evidence }, now));
});

test("child notifications require an exact task ID and an explicitly correlated turn", () => {
  for (const status of ["stopped", "completed"]) for (const format of ["queue", "user"]) {
    const content = String(stoppedNotice.row.content).replace("<status>stopped</status>", `<status>${status}</status>`);
    const sample: Sample = { line: 12153, row: { timestamp: stoppedNotice.row.timestamp,
      ...(format === "queue" ? { type: "queue-operation", operation: "enqueue", content }
        : { type: "user", promptId: "parent-turn", message: { content: [{ type: "text", text: content }] } }) } };
    assert.deepEqual(native(sample, "claude_child", { childId: childId + "-other", turnId: childTurn }), []);
    assert.deepEqual(native(sample, "claude_child", { turnId: childTurn }), []);
    const proof = native(sample, "claude_child", { childId, turnId: childTurn });
    assert.deepEqual(proof.map(e => e.kind === "signal" ? e.event : e.kind), status === "stopped" ? ["complete", "interrupted"] : ["complete"]);
    const output = evaluateState(stateInput([...childEvidence, ...proof], { turnId: childTurn }), now);
    assert.equal(output.turn.value, status === "stopped" ? "unknown" : "completed");
    assert.equal(output.result.stage, null); assert.notEqual(output.display.result, "Done");
    const uncorrelated = native(sample, "claude_child", { childId });
    assert.ok(uncorrelated.every(e => e.kind === "signal" && e.turnId === null));
    assert.equal(evaluateState(stateInput([...childEvidence, ...uncorrelated], { turnId: childTurn }), now).turn.reason, "progress_expired");
    assert.deepEqual(native({ ...sample, row: { ...sample.row, type: "assistant" } }, "claude_child", { childId, turnId: childTurn }), []);
  }
});

const deliveries: DeliveryEvidence[] = production.E2.watches.flatMap((w, i): DeliveryEvidence[] => [
  { kind: "operation", id: w.id, cmdId: w.id, target: "E2-target", bodyKey: w.bodyKey, phase: "legacy_failed", at: Date.parse(w.sent_ts), observedAt: Date.parse(w.sent_ts) },
  { kind: "receipt", id: `E2-receipt-${i}`, inputId: `input-${i}`, target: "E2-target", bodyKey: w.bodyKey, phase: "consumed", at: Date.parse(production.E2.receipts[i].row.timestamp), observedAt: Date.parse(fact([301136, 301145][i]).observed_ts) },
]);
for (const w of production.E2.watches) test(`E2: ${w.id} is Likely delivered, not Not delivered or confirmed Delivered`, () => {
  assert.equal(w.state, "failed"); assert.equal(w.normalizationMatched, true); assert.equal(w.receiverCmdIdPresent, false);
  const output = evaluateDelivery({ cmdId: w.id, evidence: deliveries }, now);
  assert.equal(output.value, "received_candidate"); assert.equal(output.display, "Likely delivered"); assert.equal(output.confidence, "inferred");
  checkOrders(deliveries, evidence => evaluateDelivery({ cmdId: w.id, evidence }, now));
});

test("production extraction retains only observed structure and preserves missing evidence", () => {
  assert.equal(production.E1.lastDescendsFromFirst, true); assert.equal(production.E1.lineCount, 271);
  assert.equal(production.E6.lineCount, 43); assert.equal(production.E6.terminalCount, 0);
  assert.equal(production.E5.locationsAvailable, false); assert.equal(production.E5.rejectedAppends, 5);
  assert.equal(fact(251644).payload.transcript_flags, undefined);
  assert.deepEqual(fact(289242).payload.transcript_flags, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  assert.equal(production.E3.rows[0].row.promptId, fact(301180).payload.last_evidence!.input!.prompt_id);
  assert.notEqual(production.E3.rows[0].row.uuid, production.E3.rows[0].row.promptId);
  assert.equal(Date.parse(fact(259872).source_ts) - Date.parse(production.E6.rows.at(-1)!.row.timestamp), 155_539);
  const warning = evaluateState(productionCases[3].input, now);
  assert.deepEqual(warning.conflicts, ["seq-301024"]); assert.ok(warning.display.details.includes("History conflict · unresolved"));
});

test("actual synchronous Agent completed is response and terminal, never async launch", () => {
  const [call, reply] = production.synchronous;
  const turnId = production.synchronousChild.row.promptId!;
  assert.equal(production.synchronousChild.parentPromptMatches, true);
  const proof = native(reply, "claude_child", { parentCall: call.row, childId: String(reply.row.toolUseResult!.agentId), turnId, attemptId: "sync" });
  const output = evaluateState(stateInput(proof, { turnId, attempt: { id: "sync", requiredStage: "responded" } }), now);
  assert.equal(output.turn.value, "completed"); assert.equal(output.result.stage, "responded"); assert.equal(output.display.result, "Done");
  checkOrders(proof, evidence => evaluateState(stateInput(evidence, { turnId, attempt: { id: "sync", requiredStage: "responded" } }), now));
});

test("actual partial text before tool_use cannot finish a turn", () => {
  const turn = production.supplemental[0].row.promptId!;
  for (const line of [13, 176]) {
    const sample = production.supplemental.find(r => r.line === line)!;
    const next = production.supplemental.find(r => r.line === line + 1)!;
    assert.equal(sample.row.message!.id, next.row.message!.id);
    const proof = native(sample, "claude", { turnId: turn });
    const output = evaluateState(stateInput(proof, { turnId: turn }), Date.parse(sample.row.timestamp));
    assert.equal(output.turn.value, "running"); assert.equal(output.display.label, "Working");
  }
});

test("actual handback is a report, SubagentStop still lacks a confirmed boundary", () => {
  const turn = production.supplemental[0].row.promptId!;
  const [call, reply, stop] = [190, 192, 194].map(line => production.supplemental.find(r => r.line === line)!);
  const proof = [native(call, "claude", { turnId: turn, attemptId: "async" }),
    native(reply, "claude", { turnId: turn, attemptId: "async", parentCall: call.row }), native(stop, "claude", { turnId: turn })].flat();
  const input = stateInput(proof, { turnId: turn, attempt: { id: "async", requiredStage: "reported" } });
  const output = evaluateState(input, now);
  assert.equal(output.result.value, "succeeded"); assert.equal(output.turn.value, "unknown");
  assert.equal(output.turn.reason, "boundary_unavailable"); assert.equal(output.display.label, "Unknown"); assert.equal(output.display.result, "Done");
  checkOrders(proof, evidence => evaluateState({ ...input, evidence }, now));
});
