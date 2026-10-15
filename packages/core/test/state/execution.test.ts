import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateState, readNativeEvidence, readNativeTurnId, renderState } from "../../src/state/index.ts";
import type { NativeRecord, StateInput, StateEvidence } from "../../src/state/index.ts";
import { checkOrders, expectedState, PROCESS, scan, signal, stateInput, summarizeState } from "./helpers.ts";
import type { StateSummary } from "./helpers.ts";

const working = { closure: "open", turn: "running", label: "Working", turnReason: "turn_progress", turnConfidence: "confirmed" } as const;
const idle = { turn: "completed", label: "Idle", turnReason: "turn_finished", turnConfidence: "confirmed" } as const;
const attempt = { id: "attempt", requiredStage: "responded" } as const;
function native(source: NativeRecord["source"], row: Record<string, unknown>, at = 10, extra: Partial<NativeRecord> = {}) {
  return readNativeEvidence({ id: `native-${at}`, source, row, runId: "run", turnId: "turn", attemptId: "attempt", at, observedAt: at, ...extra });
}
const start = signal("start");
const duration = native("claude", { type: "system", subtype: "turn_duration" });
const stop = native("hook", { hook_event_name: "Stop", prompt_id: "turn" });
const end = native("hook", { hook_event_name: "SessionEnd", prompt_id: "turn" });
const result = native("claude_sdk", { type: "result", is_error: false });

export const executionCases: { name: string; now: number; input: StateInput; expected: StateSummary }[] = [
  { name: "empty evidence is unknown", now: 0, input: stateInput([]), expected: expectedState() },
  { name: "fresh start does not require process proof", now: 1, input: stateInput([start]), expected: expectedState(working) },
  { name: "drop Stop: turn_duration still ends turn", now: 20, input: stateInput([start, ...duration]), expected: expectedState({ ...idle, closure: "open" }) },
  { name: "drop SessionEnd: successful PID scan proves exit", now: 20, input: stateInput([start, scan(10, { processes: [] })], { process: PROCESS }), expected: expectedState({ process: "exited_confirmed", hosting: "hosted", turnReason: "process_exited", label: "Stopped" }) },
  { name: "start alone without tool or busy evidence still expires", now: 300_001, input: stateInput([start, scan(300_000)], { process: PROCESS }), expected: expectedState({ process: "alive_confirmed", hosting: "hosted", closure: "open", turnReason: "progress_expired" }) },
  { name: "child ordinary progress expires even if shared process stays alive", now: 300_011, input: stateInput([start, signal("progress", 10), scan(300_000)], { process: PROCESS, attempt: { id: "attempt", requiredStage: "reported" } }), expected: expectedState({ process: "alive_confirmed", hosting: "hosted", closure: "open", turnReason: "progress_expired", result: "incomplete" }) },
  { name: "PID reuse proves old generation exited", now: 20, input: stateInput([start, scan(10, { processes: [{ pid: 41, procStart: "os-start-B" }] })], { process: PROCESS }), expected: expectedState({ process: "exited_confirmed", hosting: "hosted", label: "Stopped", turnReason: "process_exited" }) },
  { name: "missing OS start fingerprint is not absence", now: 20, input: stateInput([scan(10, { processes: [{ pid: 41, procStart: null }] })], { process: PROCESS }), expected: expectedState({ hosting: "hosted" }) },
  { name: "one corrupt sessions record keeps prior lease until expiry", now: 20, input: stateInput([scan(), scan(10, { status: "partial", processes: [], hosted: [] })], { process: PROCESS }), expected: expectedState({ process: "alive_confirmed", hosting: "hosted" }) },
  { name: "failed scan does not extend expired lease", now: 120_000, input: stateInput([scan(), scan(110_000, { status: "failed", processes: [], hosted: [] })], { process: PROCESS }), expected: expectedState() },
  { name: "failed scan alone proves neither absence nor exit", now: 20, input: stateInput([scan(10, { status: "failed", processes: [], hosted: [] })], { process: PROCESS }), expected: expectedState() },
  { name: "successful scoped absence is Not hosted, not finished", now: 20, input: stateInput([scan(10, { hosted: [], processes: undefined })]), expected: expectedState({ hosting: "not_hosted", label: "Not hosted" }) },
  { name: "scan outside target scope cannot prove absence", now: 20, input: stateInput([scan(10, { subjects: ["another"], processes: [], hosted: [] })], { process: PROCESS }), expected: expectedState() },
  { name: "not hosted expires to unknown", now: 120_010, input: stateInput([scan(10, { hosted: [] })]), expected: expectedState() },
  { name: "same turn may become hosted again", now: 30, input: stateInput([start, scan(10, { hosted: [] }), scan(20)]), expected: expectedState({ ...working, hosting: "hosted" }) },
  { name: "SessionEnd closes logically, not physically", now: 20, input: stateInput([start, ...end]), expected: expectedState({ ...idle, closure: "closed", label: "Closed" }) },
  { name: "late old turn Stop cannot close current turn", now: 30, input: stateInput([start, ...native("hook", { hook_event_name: "Stop", prompt_id: "old" }, 20, { turnId: null })]), expected: expectedState(working) },
  { name: "hook without prompt ID cannot close selected turn", now: 30, input: stateInput([start, ...native("hook", { hook_event_name: "Stop" }, 20, { turnId: null })]), expected: expectedState(working) },
  { name: "Stop is a boundary attempt, not permanent Idle", now: 20, input: stateInput([start, ...stop]), expected: expectedState({ closure: "open", turnReason: "boundary_unavailable" }) },
  { name: "Stop attempt still cannot become Idle after expiry", now: 900_000, input: stateInput([start, ...stop]), expected: expectedState({ closure: "open", turnReason: "boundary_unavailable" }) },
  { name: "blocking Stop attachment and missing continuation", now: 20, input: stateInput([start, ...native("claude", { type: "attachment", attachment: { hookEvent: "Stop", type: "hook_blocking_error" } })]), expected: expectedState({ closure: "open", turnReason: "boundary_unavailable" }) },
  { name: "Stop then continued tool work", now: 30, input: stateInput([start, ...stop, signal("progress", 20)]), expected: expectedState(working) },
  { name: "stop_reason end_turn is not user-turn completion", now: 20, input: stateInput([start, ...native("claude", { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "fixture" }] } })]), expected: expectedState({ closure: "open", turnReason: "boundary_unavailable" }) },
  { name: "plain assistant text is progress, not Done", now: 20, input: stateInput([start, ...native("claude", { type: "assistant", message: { stop_reason: null, content: [{ type: "text", text: "fixture" }] } })]), expected: expectedState(working) },
  { name: "confirmed completed turn does not expire", now: 900_000, input: stateInput([start, ...duration]), expected: expectedState({ ...idle, closure: "open" }) },
  { name: "contradictory completed and continued same turn is unknown", now: 30, input: stateInput([start, ...duration, signal("progress", 20)]), expected: expectedState({ closure: "open", turnReason: "evidence_conflict" }) },
  { name: "equal-time contradictory evidence is unknown", now: 20, input: stateInput([signal("progress", 10), signal("complete", 10)]), expected: expectedState({ turnReason: "evidence_conflict" }) },
  { name: "physical exit never resurrects with reused PID", now: 30, input: stateInput([signal("exit", 10, { process: PROCESS }), scan(20)], { process: PROCESS }), expected: expectedState({ process: "exited_confirmed", hosting: "hosted", label: "Stopped" }) },
  { name: "approval wait has its own expiry", now: 300_010, input: stateInput([signal("approval", 10), scan(300_000)], { process: PROCESS }), expected: expectedState({ process: "alive_confirmed", hosting: "hosted", turnReason: "waiting_expired" }) },
  { name: "fresh input wait is visible without liveness", now: 20, input: stateInput([signal("input", 10)]), expected: expectedState({ turn: "waiting_input", label: "Waiting", turnReason: "input_requested", turnConfidence: "confirmed" }) },
  { name: "result waits for required verification", now: 20, input: stateInput(result, { attempt: { id: "attempt", requiredStage: "verified" } }), expected: expectedState({ ...idle, result: "incomplete", stage: "responded" }) },
  { name: "responded then verification failure", now: 30, input: stateInput([...result, signal("failure", 20)], { attempt: { id: "attempt", requiredStage: "verified" } }), expected: expectedState({ ...idle, result: "failed", stage: "responded", badge: "Failed" }) },
  { name: "success and failure conflict independently of arrival", now: 30, input: stateInput([...result, signal("failure", 20)], { attempt }), expected: expectedState({ ...idle, result: "unknown", stage: "responded", badge: "No result" }) },
  { name: "matching interruption takes error out of failure", now: 30, input: stateInput([signal("interrupt_request", 5, { id: "interrupt" }), ...native("claude_sdk", { type: "result", is_error: true }, 10, { interruptId: "interrupt" })], { attempt }), expected: expectedState({ ...idle, result: "interrupted", badge: "Interrupted" }) },
  { name: "unrelated interruption does not suppress failure", now: 30, input: stateInput([signal("interrupt_request", 5, { id: "interrupt", turnId: "other" }), ...native("claude_sdk", { type: "result", is_error: true }, 10, { interruptId: "interrupt" })], { attempt }), expected: expectedState({ ...idle, result: "failed", badge: "Failed" }) },
  { name: "Codex failed turn is a failed result", now: 20, input: stateInput(native("codex", { method: "turn/completed", params: { turn: { id: "turn", status: "failed", error: { message: "redacted" } } } }), { attempt }), expected: expectedState({ ...idle, result: "failed", badge: "Failed" }) },
  { name: "report operation failure does not fail request", now: 30, input: stateInput([signal("reported", 10), signal("report_failure", 20)], { attempt: { id: "attempt", requiredStage: "reported" } }), expected: expectedState({ result: "succeeded", stage: "reported", badge: "Done" }) },
  { name: "unresolved required stage is No result", now: 20, input: stateInput([signal("responded", 10)], { attempt: { id: "attempt", requiredStage: "unknown" } }), expected: expectedState({ result: "unknown", stage: "responded", badge: "No result" }) },
  { name: "future evidence is not yet available", now: 20, input: stateInput([signal("complete", 30), signal("start", 0, { observedAt: 30 })]), expected: expectedState() },
  { name: "correction retracts a mistaken start", now: 20, input: stateInput([start, { kind: "unavailable", id: "correction", at: 10, observedAt: 10, runId: "run", supersedes: [start.id] }]), expected: expectedState() },
  { name: "successful scan does not erase history conflict", now: 20, input: stateInput([start, { kind: "conflict", id: "conflict", at: 1, observedAt: 1, runId: "run", count: 5 }, scan(10)]), expected: expectedState({ ...working, hosting: "hosted", turnConfidence: "inferred", turnReason: "history_conflict" }) },
  { name: "parent exit leaves child result unknown, never succeeded", now: 20, input: stateInput([start, signal("launched", 1), signal("exit", 10, { process: PROCESS })], { process: PROCESS, attempt }), expected: expectedState({ process: "exited_confirmed", turnReason: "process_exited", label: "Stopped", result: "unknown", stage: "launched", badge: "No result" }) },
  { name: "physical exit preserves confirmed completed result", now: 30, input: stateInput([...result, signal("exit", 20, { process: PROCESS })], { process: PROCESS, attempt }), expected: expectedState({ ...idle, process: "exited_confirmed", label: "Stopped", result: "succeeded", stage: "responded", badge: "Done" }) },
  { name: "logical close can reopen only with a new keyed start", now: 30, input: stateInput([...end, signal("start", 20, { turnId: "new-turn" })], { turnId: "new-turn" }), expected: expectedState(working) },
  { name: "child result cannot change parent turn", now: 20, input: stateInput([start, signal("reported", 10, { runId: "child" }), signal("complete", 10, { runId: "child" })]), expected: expectedState(working) },
  { name: "tool error is progress, not final request failure", now: 20, input: stateInput(native("claude", { type: "user", message: { content: [{ type: "tool_result", is_error: true, tool_use_id: "tool" }] } }), { attempt }), expected: expectedState({ turn: "running", label: "Working", turnReason: "turn_progress", turnConfidence: "confirmed", result: "incomplete" }) },
  { name: "sessions status and procStart without OS comparison prove nothing", now: 20, input: stateInput(native("claude", { pid: 41, procStart: "os-start-A", status: "busy", updatedAt: 20 }), { process: PROCESS }), expected: expectedState() },
  { name: "SDK aggregated input IDs with no known turn remain unknown", now: 20, input: stateInput(native("claude_sdk", { type: "result", is_error: false, user_message_uuids: ["a", "b"] }, 10, { turnId: null, attemptId: null }), { turnId: null, attempt: { id: null, requiredStage: "responded" } }), expected: expectedState({ turnReason: "identity_unresolved", result: "unknown", badge: "No result" }) },
  { name: "contradictory native turn IDs cannot use fallback current turn", now: 20, input: stateInput(native("codex", { method: "turn/completed", params: { turnId: "old", turn: { id: "different" } } })), expected: expectedState() },
];

for (const c of executionCases) test(c.name, () => {
  const actual = evaluateState(c.input, c.now);
  assert.deepEqual(summarizeState(actual), c.expected);
  checkOrders(c.input.evidence, evidence => evaluateState({ ...c.input, evidence }, c.now));
});

test("expiry is exact and rereading does not extend progress", () => {
  assert.equal(evaluateState(stateInput([start]), 299_999).turn.value, "running");
  assert.equal(evaluateState(stateInput([start]), 300_000).turn.value, "unknown");
  const reread = { ...start, observedAt: 299_999 };
  assert.deepEqual(evaluateState(stateInput([start]), 300_000), evaluateState(stateInput([reread]), 300_000));
});

test("native correlation fields remain distinct from row UUIDs and SDK input sets", () => {
  assert.equal(readNativeTurnId("claude", { uuid: "row", promptId: "prompt" }), "prompt");
  assert.equal(readNativeTurnId("hook", { prompt_id: "prompt" }), "prompt");
  assert.equal(readNativeTurnId("codex", { payload: { turn_id: "turn" } }), "turn");
  assert.equal(readNativeTurnId("codex", { result: { turn: { id: "turn" } } }), "turn");
  assert.equal(readNativeTurnId("codex", { params: { turn: { id: "turn" } } }), "turn");
  assert.equal(readNativeTurnId("claude_sdk", { user_message_uuids: ["input-a", "input-b"] }), null);
  assert.equal(readNativeTurnId("claude", { uuid: "row" }), null);
});

test("N1 Codex collab operation completion is not child response", () => {
  for (const tool of ["spawnAgent", "wait", "closeAgent"]) {
    const proof = native("codex_child", { method: "item/completed", params: { item: { type: "collabAgentToolCall", tool, status: "completed", receiverThreadIds: ["child", "other"], agentsStates: { child: { status: "running" } } } } }, 10, { childId: "child" });
    const s = evaluateState(stateInput([start, ...proof], { attempt }), 20);
    assert.equal(s.display.label, "Working"); assert.equal(s.result.value, "incomplete");
    assert.deepEqual(s.result.stages, tool === "spawnAgent" ? ["launched"] : []);
  }
});

test("N1 wait requires target child completed and response, not another child's result", () => {
  const row = { method: "item/completed", params: { item: { type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["child", "other"], agentsStates: { child: { status: "completed", message: "fixture" }, other: { status: "running" } } } } };
  assert.equal(evaluateState(stateInput(native("codex_child", row, 10, { childId: "child" }), { attempt }), 20).result.value, "succeeded");
  assert.equal(evaluateState(stateInput(native("codex_child", row, 10, { childId: "other" }), { attempt }), 20).result.value, "incomplete");
});

test("N7 all 270 display combinations have one label, result never selects activity", () => {
  let count = 0;
  for (const resolved of [false, true]) for (const process of ["alive_confirmed", "exited_confirmed", "unverified"] as const)
    for (const hosting of ["hosted", "not_hosted", "unknown"] as const) for (const closure of ["open", "closed", "unknown"] as const)
      for (const turn of ["running", "waiting_approval", "waiting_input", "completed", "unknown"] as const) {
        const expected = !resolved ? "Unresolved" : process === "exited_confirmed" ? "Stopped" : turn === "running" ? "Working"
          : turn === "waiting_approval" ? "Needs approval" : turn === "waiting_input" ? "Waiting" : closure === "closed" ? "Closed"
            : hosting === "not_hosted" ? "Not hosted" : turn === "completed" ? "Idle" : "Unknown";
        assert.equal(renderState(resolved, process, hosting, closure, turn), expected); count++;
      }
  assert.equal(count, 270);
});

test("inferred progress and failed observation are visible independently", () => {
  const s = evaluateState(stateInput([signal("progress", 0, { confidence: "inferred" }), scan(1, { status: "partial" })]), 10);
  assert.equal(s.display.label, "Working"); assert.ok(s.display.details.includes("unconfirmed"));
  assert.equal(s.observation[0].state, "failed");
});

test("N8 a later summary correction retracts the start that actually existed", () => {
  const row = { type: "user", promptId: "turn", message: { content: "fixture summary" } };
  const old = native("claude", row, 0);
  const corrected = native("claude", { ...row, isCompactSummary: true }, 0, { id: "corrected", observedAt: 20, supersedes: old.map(e => e.id) });
  const evidence = [...old, ...corrected];
  assert.equal(evaluateState(stateInput(evidence), 10).turn.value, "running");
  assert.equal(evaluateState(stateInput(evidence), 20).turn.value, "unknown");
  checkOrders(evidence, evidence => evaluateState(stateInput(evidence), 20));
});

test("N2 success, failure and interruption sets have one result in all orders", () => {
  const evidence = [signal("responded", 10), signal("failure", 20), signal("interrupt_request", 25, { id: "request" }), signal("failure", 30, { interruptId: "request" })];
  const input = stateInput(evidence, { attempt });
  const output = evaluateState(input, 40);
  assert.equal(output.result.value, "unknown"); assert.equal(output.result.reason, "evidence_conflict");
  checkOrders(evidence, evidence => evaluateState({ ...input, evidence }, 40));
});

for (const [name, source, row] of [
  ['Claude Esc', 'claude', { type: 'user', message: { content: '[Request interrupted by user]' } }],
  ['Claude tool Esc', 'claude', { type: 'user', message: { content: '[Request interrupted by user for tool use]' } }],
  ['Codex aborted', 'codex', { type: 'event_msg', payload: { type: 'turn_aborted' } }],
  ['Codex interrupted', 'codex', { method: 'turn/completed', params: { turn: { status: 'interrupted' } } }],
] as const) test(`${name} は子の停止通知と区別し Idle へ戻す`, () => {
  const result = evaluateState(stateInput([start, ...native(source, row, 10)]), 20);
  assert.equal(result.display.label, 'Idle');
  assert.equal(result.turn.reason, 'turn_finished');
});
