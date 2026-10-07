import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Fact, FactInput, RunPayload, Source } from "../../src/ledger/facts.ts";
import { projectConnections } from "../../src/ledger/projections/connections.ts";
import { projectRuns } from "../../src/ledger/projections/runs.ts";
import type { EndEvidence } from "../../src/ledger/projections/runs.ts";

const SOURCE_TS = "2026-01-01T00:00:00.000Z";
const LATER_TS = "2026-01-01T00:40:00.000Z";
const SHUFFLE_SEED = 123456789;
const SHUFFLE_REPETITIONS = 32;

function createFact(input: FactInput): Fact {
  return {
    ...input, seq: 1, fact_id: input.source_event_id, payload_hash: "structural-test",
    source_ts: input.source_ts, observed_ts: SOURCE_TS, schema_version: 1,
    cursor: null, supersedes: input.supersedes ?? null,
  } as Fact;
}

function createRun(id = "start", payload: Partial<RunPayload> = {}): Fact {
  return createFact({
    source: "host-claude", source_event_id: id, kind: "run.created", subject: "run:r1",
    payload: { conversation_id: "c1", generation: 1, state: "running", pid: 101, start_fingerprint: "process-1", ...payload },
    source_ts: SOURCE_TS, confidence: "confirmed",
  });
}

function createState(payload: Partial<RunPayload> & Pick<RunPayload, "state">, source: Source = "host-claude", id = "state"): Fact {
  return createFact({
    source, source_event_id: id, kind: "run.state_changed", subject: "run:r1",
    payload, source_ts: LATER_TS, confidence: "confirmed",
  });
}

function shuffleFacts(facts: readonly Fact[], seed: number): Fact[] {
  const shuffled = [...facts];
  let state = seed;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

for (const sample of ["S2", "S3", "S11"]) {
  test(`${sample}: 標本の投影と固定種の並べ替えが一致する`, () => {
    const root = new URL(`../samples/${sample}/`, import.meta.url);
    const facts = JSON.parse(readFileSync(new URL("facts.json", root), "utf8")) as Fact[];
    const expected = JSON.parse(readFileSync(new URL("expected.json", root), "utf8"));
    const snapshot = JSON.stringify(facts);
    for (let iteration = 0; iteration <= SHUFFLE_REPETITIONS; iteration += 1) {
      const input = iteration === 0 ? facts : shuffleFacts(facts, SHUFFLE_SEED + iteration);
      assert.deepEqual({ runs: projectRuns(input), connections: projectConnections(input) }, expected);
    }
    assert.equal(JSON.stringify(facts), snapshot);
    assert.ok(!snapshot.includes('"body"'));
  });
}

const END_CASES: { source: Source; evidence: EndEvidence }[] = [
  { source: "host-claude", evidence: { kind: "host_exit", exit_code: 0 } },
  { source: "host-codex", evidence: { kind: "thread_closed" } },
  { source: "hook", evidence: { kind: "session_end", generation: 1 } },
  { source: "rollout-codex", evidence: { kind: "archived", location: "archived_sessions" } },
  { source: "hook", evidence: { kind: "process_check", succeeded: true, matches: false, pid: 101, start_fingerprint: "process-1" } },
  { source: "ui", evidence: { kind: "user_correction" } },
  { source: "legacy", evidence: { kind: "legacy_delegation", table: "delegations", id: "d1", status: "done" } },
];
for (const { source, evidence } of END_CASES) {
  test(`終了の根拠 ${evidence.kind} を確認する`, () => {
    const runs = projectRuns([createRun(), createState({ state: "ended", end_evidence: evidence }, source)]);
    assert.equal(runs[0].state, "ended");
    assert.deepEqual(runs[0].end_evidence, evidence);
    assert.equal(runs[0].ended_ts, LATER_TS);
  });
}

test("旧委譲の失敗は確認済みの記録だけを根拠にし、idle や別の出所を終了としない", () => {
  const evidence = { kind: "legacy_delegation", table: "delegations", id: "d1", status: "failed" };
  const failed = createState({ state: "failed", cause: "legacy delegation failed", end_evidence: evidence }, "legacy");
  assert.equal(projectRuns([createRun(), failed])[0].state, "failed");
  for (const fact of [
    { ...failed, confidence: "inferred" as const },
    { ...failed, source: "hook" as const },
    createState({ state: "ended", end_evidence: { ...evidence, status: "idle" } }, "legacy"),
    createState({ state: "ended", end_evidence: evidence }, "legacy"),
  ]) {
    const run = projectRuns([createRun(), fact])[0];
    assert.equal(run.state, "unknown");
    assert.equal(run.ended_ts, undefined);
  }
});

for (const reason of ["no_updates", "mcp_disconnected", "runner_restarted", "runner_updated", "api_restarted", "process_list_failed"]) {
  test(`${reason} は終了にせず最後の根拠を保持する`, () => {
    const start = createRun();
    const run = projectRuns([start, createState({ state: "unknown", reason })])[0];
    assert.equal(run.state, "unknown");
    assert.equal(run.reason, reason);
    assert.deepEqual(run.last_evidence, { fact_id: start.fact_id, kind: start.kind });
    assert.equal(run.last_evidence_ts, SOURCE_TS);
    assert.equal(run.end_evidence, undefined);
    assert.equal(run.ended_ts, undefined);
    assert.equal(projectRuns([start, createState({ state: "ended", reason })])[0].state, "unknown");
  });
}

test("世代、PID、開始指紋、確認の成功、出所、確度の不一致は終了の根拠にしない", () => {
  const invalid = [
    createState({ state: "ended", end_evidence: { kind: "session_end", generation: 2 } }, "hook"),
    ...[
      { succeeded: false }, { matches: true }, { pid: 102 }, { start_fingerprint: "reused-pid" },
    ].map((patch) => createState({ state: "ended", end_evidence: {
      kind: "process_check", succeeded: true, matches: false, pid: 101, start_fingerprint: "process-1", ...patch,
    } })),
    createState({ state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } }, "hook"),
    { ...createState({ state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } }), confidence: "inferred" } as Fact,
    createState({ state: "ended", end_evidence: { kind: "unrecognized" } }),
  ];
  for (const fact of invalid) assert.equal(projectRuns([createRun(), fact])[0].state, "unknown");
});

test("失敗には終了の根拠と原因の両方が必要", () => {
  assert.equal(projectRuns([createRun(), createState({ state: "failed", cause: "host error" })])[0].state, "unknown");
  assert.equal(projectRuns([createRun(), createState({ state: "failed", end_evidence: { kind: "host_exit", exit_code: 1 } })])[0].state, "unknown");
  const failed = projectRuns([createRun(), createState({ state: "failed", cause: "host error", end_evidence: { kind: "host_exit", exit_code: 1 } })])[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.cause, "host error");
});

test("Claude の同じターンの中断を照合し failed にしない", () => {
  const request = createFact({
    source: "ui", source_event_id: "interrupt", kind: "run.interrupt_requested", subject: "run:r1",
    payload: { turn_id: "turn-1" }, source_ts: "2026-01-01T00:30:00.000Z", confidence: "confirmed",
  });
  const result = createState({ state: "failed", cause: "error_during_execution", end_evidence: {
    kind: "host_exit", exit_code: 1, turn_id: "turn-1", is_error: true, subtype: "error_during_execution",
  } });
  const input = [createRun(), request, result];
  const run = projectRuns(input)[0];
  assert.equal(run.state, "ended");
  assert.equal((run.end_evidence as { interrupted: boolean }).interrupted, true);
  assert.equal(run.cause, undefined);
  for (let iteration = 0; iteration < SHUFFLE_REPETITIONS; iteration += 1) {
    assert.deepEqual(projectRuns(shuffleFacts(input, SHUFFLE_SEED + iteration)), [run]);
  }
  assert.equal(projectRuns([input[0], result])[0].state, "failed");
  assert.equal(projectRuns([input[0], { ...request, payload: { turn_id: "other-turn" } } as Fact, result])[0].state, "failed");
  const exit = createState({ state: "failed", cause: "exit 1", end_evidence: { kind: "host_exit", exit_code: 1, turn_id: "turn-1" } });
  assert.equal(projectRuns([input[0], request, exit])[0].state, "ended");
});

test("訂正された終了と接続の事実を除外する", () => {
  const end = createState({ state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } });
  const correction = createFact({
    source: "ui", source_event_id: "correction", kind: "run.corrected", subject: "run:r1",
    payload: { state: "running" }, supersedes: end.fact_id, source_ts: LATER_TS, confidence: "confirmed",
  });
  assert.equal(projectRuns([end, correction, createRun()])[0].state, "running");
  const connection = createFact({
    source: "hook", source_event_id: "connect", kind: "connection.created", subject: "connection:m1",
    payload: { run_id: "r1", type: "mcp", fingerprint: "m1", state: "connected" }, source_ts: SOURCE_TS, confidence: "confirmed",
  });
  const disconnect = createFact({
    source: "hook", source_event_id: "disconnect", kind: "connection.state_changed", subject: "connection:m1",
    payload: { state: "disconnected" }, source_ts: LATER_TS, confidence: "confirmed",
  });
  const corrected = createFact({
    source: "ui", source_event_id: "connection-correction", kind: "connection.corrected", subject: "connection:m1",
    payload: { state: "connected" }, supersedes: disconnect.fact_id, source_ts: LATER_TS, confidence: "confirmed",
  });
  assert.equal(projectConnections([corrected, disconnect, connection])[0].state, "connected");
  assert.deepEqual(projectRuns([createRun(), connection, disconnect]), projectRuns([createRun()]));
});

test("同じ subject の再開も独立した世代とし古い PID を引き継がない", () => {
  const resume = { ...createRun("resume", { generation: 2 }), source_ts: "2026-01-01T00:01:00.000Z" };
  assert.ok(resume.kind === "run.created");
  delete resume.payload?.pid;
  delete resume.payload?.start_fingerprint;
  const death = createState({ generation: 1, state: "ended", end_evidence: {
    kind: "process_check", succeeded: true, matches: false, pid: 101, start_fingerprint: "process-1",
  } });
  const runs = projectRuns([death, resume, createRun()]);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].state, "ended");
  assert.equal(runs[1].state, "running");
  assert.equal(runs[1].pid, undefined);
  assert.equal(runs[1].start_fingerprint, undefined);
});

test("source_ts と source_event_id で順序を決め seq と observed_ts を無視する", () => {
  const first = createState({ state: "waiting_approval" }, "host-claude", "a");
  const second = createState({ state: "waiting_input" }, "host-claude", "z");
  assert.equal(projectRuns([second, createRun(), first])[0].state, "waiting_input");
  const facts = [createRun(), first, second].map((fact, index) => ({ ...fact, seq: 100 - index, observed_ts: "2099-01-01T00:00:00.000Z" }));
  assert.deepEqual(projectRuns(facts.reverse()), projectRuns([createRun(), first, second]));
});

test("unknown は新しい確かな状態でのみ解消する", () => {
  const unknown = createState({ state: "unknown", reason: "no_updates" }, "host-claude", "a");
  const inferred = { ...createState({ state: "running" }, "hook", "b"), confidence: "inferred" } as Fact;
  const confirmed = createState({ state: "idle" }, "host-claude", "c");
  assert.equal(projectRuns([createRun(), unknown, inferred])[0].state, "unknown");
  assert.equal(projectRuns([createRun(), unknown, inferred, confirmed])[0].state, "idle");
  assert.equal(projectRuns([createRun(), unknown, inferred, confirmed])[0].reason, undefined);
});

test("保持整理済みの null payload を安全に無視する", () => {
  const purged = { ...createState({ state: "ended" }), payload: null } as Fact;
  assert.deepEqual(projectRuns([purged, createRun()]), projectRuns([createRun()]));
  assert.deepEqual(projectConnections([purged]), []);
});
