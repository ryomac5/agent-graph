import assert from "node:assert/strict";
import type { Signal, StateInput, StateDecision, StateEvidence, Scan } from "../../src/state/index.ts";

export const PROCESS = { pid: 41, procStart: "os-start-A" };
export function signal(event: Signal["event"], at = 0, extra: Partial<Signal> = {}): Signal {
  return { kind: "signal", id: `${event}-${at}`, runId: "run", turnId: "turn", attemptId: "attempt", at, observedAt: at, event, ...extra };
}
export function scan(at = 0, extra: Partial<Scan> = {}): Scan {
  return { kind: "scan", id: `scan-${at}`, source: "sessions", scope: "local", subjects: ["run"], at, observedAt: at, status: "succeeded", validForMs: 120_000, processes: [PROCESS], hosted: ["run"], ...extra };
}
export function stateInput(evidence: readonly StateEvidence[], extra: Partial<StateInput> = {}): StateInput {
  return { runId: "run", turnId: "turn", process: null, attempt: null, evidence, ...extra };
}
export function summarizeState(s: StateDecision) {
  return { process: s.process.value, hosting: s.hosting.value, closure: s.closure.value, turn: s.turn.value,
    result: s.result.value, stage: s.result.stage, label: s.display.label, badge: s.display.result,
    turnReason: s.turn.reason, turnConfidence: s.turn.confidence };
}
export type StateSummary = ReturnType<typeof summarizeState>;
export function expectedState(changes: Partial<StateSummary> = {}): StateSummary {
  return { process: "unverified", hosting: "unknown", closure: "unknown", turn: "unknown", result: "not_applicable",
    stage: null, label: "Unknown", badge: null, turnReason: "missing_evidence", turnConfidence: "unknown", ...changes };
}

export function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) {
    for (const tail of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...tail];
  }
}

export function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

export function checkOrders<T, R>(items: readonly T[], evaluate: (items: readonly T[]) => R): void {
  const expected = evaluate(freezeDeep(items));
  for (const order of permutations(items)) {
    const accumulated: T[] = [];
    for (const item of order) { accumulated.push(item); evaluate(accumulated); }
    assert.deepEqual(evaluate(accumulated), expected);
  }
  assert.deepEqual(evaluate([...items, ...items]), expected);
}
