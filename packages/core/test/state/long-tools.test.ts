import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluateState, readNativeEvidence } from "../../src/state/index.ts";
import type { NativeRecord, Signal, StateEvidence } from "../../src/state/index.ts";
import { checkOrders, PROCESS, scan, signal, stateInput } from "./helpers.ts";

function native(source: NativeRecord["source"], row: Record<string, unknown>, at = 0, extra: Partial<NativeRecord> = {}) {
  return readNativeEvidence({ id: `${source}-${at}`, source, row, runId: "run", turnId: "turn", at, observedAt: at, ...extra });
}
const tool = (phase: "started" | "finished", at = 0, id = "tool") => signal("progress", at, { tools: [{ id, phase }] });
const alive = scan(300_000);
const input = (evidence: readonly StateEvidence[]) => stateInput(evidence, { process: PROCESS });

const recordPairs: { name: string; source: NativeRecord["source"]; start: Record<string, unknown>; finish: Record<string, unknown> }[] = [
  { name: "Claude tool_use/result", source: "claude", start: { type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Bash" }] } }, finish: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool" }] } } },
  { name: "hook PreToolUse/PostToolUse", source: "hook", start: { hook_event_name: "PreToolUse", tool_use_id: "tool" }, finish: { hook_event_name: "PostToolUse", tool_use_id: "tool" } },
  { name: "attachment PreToolUse/PostToolUse", source: "claude", start: { type: "attachment", attachment: { hookEvent: "PreToolUse", toolUseID: "tool" } }, finish: { type: "attachment", attachment: { hookEvent: "PostToolUse", toolUseID: "tool" } } },
  { name: "Codex function_call/output", source: "codex", start: { type: "response_item", payload: { type: "function_call", call_id: "tool" } }, finish: { type: "response_item", payload: { type: "function_call_output", call_id: "tool" } } },
  { name: "Codex commandExecution", source: "codex", start: { method: "item/started", params: { item: { type: "commandExecution", id: "tool" } } }, finish: { method: "item/completed", params: { item: { type: "commandExecution", id: "tool" } } } },
];
for (const c of recordPairs) test(`${c.name}: long live tool stays Working until its result`, () => {
  const started = native(c.source, c.start);
  const finished = native(c.source, c.finish, 310_001);
  assert.deepEqual(started.map(e => (e as Signal).tools), [[{ id: "tool", phase: "started" }]]);
  assert.deepEqual(finished.map(e => (e as Signal).tools), [[{ id: "tool", phase: "finished" }]]);
  const evidence = [...started, alive];
  const output = evaluateState(input(evidence), 310_000);
  assert.equal(output.display.label, "Working");
  assert.ok(output.display.details.includes("running tool"));
  assert.equal(output.turn.reason, "running_tool");
  assert.equal(output.turn.validUntil, 420_000);
  assert.ok(output.turn.evidenceIds.includes(alive.id));
  checkOrders(evidence, evidence => evaluateState(input(evidence), 310_000));
  const after = evaluateState(input([...evidence, ...finished]), 310_001);
  assert.equal(after.turn.reason, "turn_progress");
  assert.equal(after.display.details.includes("running tool"), false);
  const later = [...evidence, ...finished, scan(610_001)];
  assert.equal(evaluateState(input(later), 610_001).turn.reason, "progress_expired");
  checkOrders(later, evidence => evaluateState(input(evidence), 610_001));
});

test("drop task_complete: a living Codex process retains an outstanding tool", () => {
  const evidence = [signal("start"), ...native("codex", recordPairs[3].start, 1), alive];
  const output = evaluateState(input(evidence), 310_000);
  assert.equal(output.display.label, "Working");
  assert.equal(output.turn.reason, "running_tool");
  checkOrders(evidence, evidence => evaluateState(input(evidence), 310_000));
});

test("long tool loses Working at the exact liveness deadline, failed scans do not extend it", () => {
  const evidence = [tool("started"), alive, scan(419_999, { status: "failed" })];
  assert.equal(evaluateState(input(evidence), 419_999).display.label, "Working");
  const expired = evaluateState(input(evidence), 420_000);
  assert.equal(expired.process.reason, "liveness_expired");
  assert.equal(expired.display.label, "Unknown");
  assert.equal(expired.display.details.includes("running tool"), false);
  checkOrders(evidence, evidence => evaluateState(input(evidence), 420_000));
  assert.equal(evaluateState(input([...evidence, scan(420_001)]), 420_001).display.label, "Working");
});

for (const [name, end] of [
  ["exit", signal("exit", 310_000, { process: PROCESS })],
  ["absence", scan(310_000, { processes: [] })],
  ["PID reuse", scan(310_000, { processes: [{ ...PROCESS, procStart: "another" }] })],
] as const) test(`long tool cannot survive ${name}`, () => {
  const evidence = [tool("started"), alive, end, scan(320_000)];
  const output = evaluateState(input(evidence), 320_000);
  assert.equal(output.display.label, "Stopped"); assert.equal(output.turn.value, "unknown");
  assert.equal(output.display.details.includes("running tool"), false);
  checkOrders(evidence, evidence => evaluateState(input(evidence), 320_000));
});

for (const event of ["stop_attempt", "complete", "close", "archive", "approval", "input"] as const) test(`long tool does not override ${event}`, () => {
  const evidence = [tool("started"), alive, signal(event, 310_000)];
  const output = evaluateState(input(evidence), 310_000);
  assert.notEqual(output.display.label, "Working");
  assert.equal(output.display.details.includes("running tool"), false);
  checkOrders(evidence, evidence => evaluateState(input(evidence), 310_000));
  assert.notEqual(evaluateState(input([...evidence, signal("progress", 320_000), scan(620_000)]), 620_000).display.label, "Working");
});

test("parallel tools close by ID, repeated PreToolUse cannot reopen a finished tool", () => {
  const evidence = [tool("started", 0, "one"), tool("started", 1, "two"), tool("finished", 10, "two"), alive];
  assert.equal(evaluateState(input(evidence), 310_000).turn.reason, "running_tool");
  checkOrders(evidence, evidence => evaluateState(input(evidence), 310_000));
  const finished = [...evidence, tool("finished", 20, "one"), ...native("hook", { hook_event_name: "PreToolUse", tool_use_id: "one" }, 2, { observedAt: 300_000 })];
  assert.equal(evaluateState(input(finished), 310_000).turn.reason, "progress_expired");
  checkOrders(finished, evidence => evaluateState(input(evidence), 310_000));
});

test("another run or turn cannot supply a running tool", () => {
  for (const extra of [{ runId: "child" }, { turnId: "previous" }]) {
    const evidence = [signal("progress"), { ...tool("started", 10), ...extra }, alive];
    assert.equal(evaluateState(input(evidence), 310_000).display.label, "Unknown");
  }
});

const busyRow = { ...PROCESS, status: "busy", statusUpdatedAt: 500_000, updatedAt: 790_000 };
test("sessions busy progress uses statusUpdatedAt, never reread time or process heartbeat", () => {
  const evidence = native("claude_session", busyRow, 790_000);
  const output = evaluateState(input(evidence), 790_000);
  assert.equal(output.display.label, "Working"); assert.equal(output.process.value, "unverified");
  assert.equal(output.turn.at, 500_000); assert.equal(output.turn.validUntil, 800_000);
  assert.ok(output.display.details.includes("liveness unverified"));
  const reread = native("claude_session", busyRow, 799_999, { id: "reread" });
  const proof = [...evidence, ...reread, scan(800_000)];
  assert.equal(evaluateState(input(proof), 800_000).turn.reason, "progress_expired");
  checkOrders(proof, evidence => evaluateState(input(evidence), 800_000));
});

test("sessions busy cannot override exit, a newer Stop or completion", () => {
  const busy = native("claude_session", busyRow, 790_000);
  for (const event of ["exit", "stop_attempt", "complete"] as const) {
    const evidence = [...busy, signal(event, 600_000, { process: PROCESS })];
    assert.notEqual(evaluateState(input(evidence), 790_000).display.label, "Working");
    checkOrders(evidence, evidence => evaluateState(input(evidence), 790_000));
  }
});

test("sessions progress requires busy, a finite status timestamp and matching process/turn", () => {
  for (const changes of [{ status: "idle" }, { statusUpdatedAt: undefined }, { statusUpdatedAt: NaN }, { statusUpdatedAt: 900_000 },
    { pid: 99 }, { procStart: "old-generation" }]) {
    assert.equal(evaluateState(input(native("claude_session", { ...busyRow, ...changes }, 790_000)), 790_000).display.label, "Unknown");
  }
  assert.equal(evaluateState(input(native("claude_session", busyRow, 790_000, { turnId: null })), 790_000).display.label, "Unknown");
});

test("synchronous Agent accepts boolean and string false, never true or absent values", () => {
  const reply = { toolUseResult: { agentId: "child", status: "completed", content: [{ type: "text", text: "fixture" }] }, message: { content: [{ type: "tool_result", tool_use_id: "call" }] } };
  for (const background of [false, "false", true, "true", undefined]) {
    const parentCall = { message: { content: [{ type: "tool_use", id: "call", name: "Agent", input: { run_in_background: background } }] } };
    const proof = native("claude_child", reply, 10, { parentCall, childId: "child", attemptId: "attempt" });
    const output = evaluateState(stateInput(proof, { attempt: { id: "attempt", requiredStage: "responded" } }), 20);
    assert.equal(output.result.value, background === false || background === "false" ? "succeeded" : "incomplete");
    assert.equal(output.turn.value, background === false || background === "false" ? "completed" : "unknown");
  }
});

interface Sample { line: number; row: Record<string, unknown> & { timestamp: string; promptId?: string } }
interface Fixture {
  bash: { durationMs: number; turn: { promptId: string }; rows: Sample[] };
  synchronous: { durationMs: number; turn: { promptId: string }; rows: Sample[]; childRows: Sample[]; childPromptMatches: boolean };
  hooks: { seq: number; source_ts: string; observed_ts: string; row: Record<string, unknown> }[];
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/long-tools.json", import.meta.url), "utf8")) as Fixture;
function readSamples(rows: Sample[], turnId: string, runId = "run") {
  return rows.flatMap(({ line, row }) => native("claude", row, Date.parse(row.timestamp), { id: `${runId}-line-${line}`, turnId, runId }));
}

for (const name of ["bash", "synchronous"] as const) test(`production ${name}: long tool fixture stays visible with a supplied liveness lease`, () => {
  const sample = fixture[name];
  const turnId = sample.turn.promptId;
  const callAt = Date.parse(sample.rows[0].row.timestamp);
  const reply = sample.rows.find(s => s.row.type === "user")!;
  const replyAt = Date.parse(reply.row.timestamp);
  assert.equal(replyAt - callAt, sample.durationMs);
  const now = name === "bash" ? replyAt - 1 : Date.parse(fixture.synchronous.childRows[1].row.timestamp);
  // 当時の OS 照会は記録にない。生存確認を与えた場合の判定を検査する。
  const evidence = [...readSamples(sample.rows, turnId), scan(now)];
  const target = stateInput(evidence, { turnId, process: PROCESS });
  const output = evaluateState(target, now);
  assert.equal(output.display.label, "Working"); assert.equal(output.turn.reason, "running_tool");
  assert.ok(output.display.details.includes("running tool"));
  checkOrders(evidence, evidence => evaluateState({ ...target, evidence }, now));
  assert.equal(evaluateState({ ...target, process: null }, now).display.label, "Unknown");
  assert.equal(evaluateState(target, replyAt).turn.reason, "turn_progress");
  if (name === "synchronous") {
    assert.equal(fixture.synchronous.childPromptMatches, true);
    const child = evaluateState(stateInput(readSamples(fixture.synchronous.childRows, turnId, "child"), { runId: "child", turnId }), now);
    assert.equal(child.display.label, "Working");
  }
});

test("production hook facts preserve PreToolUse and PostToolUse as progress", () => {
  for (const f of fixture.hooks) {
    const proof = native("hook", f.row, Date.parse(f.source_ts), { id: `seq-${f.seq}`, observedAt: Date.parse(f.observed_ts), turnId: null });
    assert.equal(proof.length, 1);
    const s = proof[0] as Signal;
    assert.equal(s.event, "progress"); assert.equal(s.turnId, f.row.prompt_id);
    assert.deepEqual(s.tools, [{ id: f.row.tool_use_id, phase: f.row.hook_event_name === "PreToolUse" ? "started" : "finished" }]);
  }
});
