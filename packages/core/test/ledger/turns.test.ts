import assert from "node:assert/strict";
import test from "node:test";
import type { Fact, FactInput, JsonValue } from "../../src/ledger/facts.ts";
import { projectRuns } from "../../src/ledger/projections/runs.ts";
import { serializeValue } from "../../src/ledger/projections/relations.ts";
import { classifyClaudeRecord, classifyCodexRecord, classifyHookEvent, isTurnEvidence, readCodexTurnModel } from "../../src/ledger/turns.ts";

type Row = { [key: string]: JsonValue };
const user = (content: JsonValue, extra: Row = {}): Row => ({ type: "user", uuid: "u", message: { role: "user", content }, ...extra });
const assistant = (content: JsonValue, stop: string | null, model = "claude-test"): Row =>
  ({ type: "assistant", uuid: "a", message: { role: "assistant", model, content, stop_reason: stop } });

test("Claude: 利用者の発言と道具の呼び出しは running、最終の応答と中断と所要時間の記録は idle にする", () => {
  assert.deepEqual(classifyClaudeRecord(user("Build it")), { state: "running", kind: "turn_started", turn_id: "u" });
  assert.equal(classifyClaudeRecord(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]))?.state, "running");
  assert.deepEqual(classifyClaudeRecord(assistant([{ type: "tool_use", id: "t", name: "Bash", input: {} }], "tool_use")),
    { state: "running", kind: "tool_call", turn_id: "a", model: "claude-test" });
  assert.equal(classifyClaudeRecord(assistant([{ type: "thinking", thinking: "..." }], "tool_use"))?.state, "running");
  assert.deepEqual(classifyClaudeRecord(assistant([{ type: "text", text: "Done." }], "end_turn")),
    { state: "idle", kind: "turn_completed", turn_id: "a", model: "claude-test" });
  assert.equal(classifyClaudeRecord(user([{ type: "text", text: "[Request interrupted by user]" }]))?.kind, "turn_interrupted");
  assert.equal(classifyClaudeRecord(user("[Request interrupted by user for tool use]"))?.state, "idle");
  assert.deepEqual(classifyClaudeRecord({ type: "system", subtype: "turn_duration", uuid: "s" }), { state: "idle", kind: "turn_completed", turn_id: "s" });
  // 止まり方のない旧い版では、本文だけの応答を最終とし、思考だけの行は途中とする。
  assert.equal(classifyClaudeRecord(assistant([{ type: "text", text: "Answer" }], null))?.state, "idle");
  assert.equal(classifyClaudeRecord(assistant([{ type: "thinking", thinking: "..." }], null))?.state, "running");
  // 合成の応答のモデルは記録しない。
  assert.equal(classifyClaudeRecord(assistant([{ type: "text", text: "No response requested." }], "stop_sequence", "<synthetic>"))?.model, undefined);
});

test("Claude: 端末の操作と補助の行はターンの根拠にしない", () => {
  for (const row of [
    user("<command-name>/exit</command-name>"), user("<local-command-stdout>(no content)</local-command-stdout>"),
    user("<local-command-caveat>Caveat</local-command-caveat>"), user("<bash-input>ls</bash-input>"),
    user("Skill body", { isMeta: true }), user("Summary", { isCompactSummary: true }), user(""),
    { type: "system", subtype: "stop_hook_summary" }, { type: "system", subtype: "compact_boundary", uuid: "c" },
    { type: "summary", summary: "x" }, { type: "file-history-snapshot" },
  ]) assert.equal(classifyClaudeRecord(row), undefined, JSON.stringify(row));
});

test("Codex: turn の開始は running、完了と中断は idle、承認の要求は waiting_approval にする", () => {
  assert.deepEqual(classifyCodexRecord({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    { state: "running", kind: "turn_started", turn_id: "t1" });
  assert.equal(classifyCodexRecord({ type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } })?.state, "idle");
  assert.equal(classifyCodexRecord({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t1" } })?.kind, "turn_interrupted");
  assert.equal(classifyCodexRecord({ method: "turn/started", params: { turnId: "t2" } })?.turn_id, "t2");
  assert.equal(classifyCodexRecord({ method: "turn/completed", params: { turn: { id: "t2" } } })?.turn_id, "t2");
  assert.equal(classifyCodexRecord({ method: "item/commandExecution/requestApproval", id: "r1" })?.state, "waiting_approval");
  assert.equal(classifyCodexRecord({ method: "thread/status/changed", params: { status: { type: "active", activeFlags: ["waitingOnApproval"] } } })?.state, "waiting_approval");
  assert.equal(classifyCodexRecord({ type: "response_item", payload: { type: "function_call" } }), undefined);
  assert.deepEqual(readCodexTurnModel({ type: "turn_context", payload: { model: "gpt-test", effort: "high" } }), { model: "gpt-test", effort: "high" });
  assert.deepEqual(readCodexTurnModel({ type: "turn_context", payload: { padding: "x" } }), {});
});

test("hook: プロンプトの送信は running、Stop は idle にし、他の出来事は状態を変えない", () => {
  assert.equal(classifyHookEvent("UserPromptSubmit")?.state, "running");
  assert.equal(classifyHookEvent("Stop")?.state, "idle");
  assert.equal(classifyHookEvent("PreToolUse"), undefined);
  assert.equal(isTurnEvidence({ hook_event_name: "UserPromptSubmit" }), true);
  assert.equal(isTurnEvidence({ kind: "tool_call" }), true);
  assert.equal(isTurnEvidence({ status: "running" }), false);
});

function fact(input: FactInput): Fact {
  return { ...input, seq: 1, fact_id: `${input.source}:${input.source_event_id}`, payload_hash: "hash", observed_ts: input.source_ts,
    schema_version: 1, cursor: null, supersedes: null } as Fact;
}

test("旧い daemon の running と waiting はターンの根拠がないので不明にし、時間からは終わりを推定しない", () => {
  const created = fact({ source: "legacy", source_event_id: "run", kind: "run.created", subject: "run:legacy-run",
    payload: { conversation_id: "legacy-conversation", generation: 0, state: "starting", started_ts: "2026-10-06T00:00:00Z" },
    source_ts: "2026-10-06T00:00:00Z", confidence: "confirmed" });
  for (const state of ["running", "waiting_input"] as const) {
    const status = fact({ source: "legacy", source_event_id: `state-${state}`, kind: "run.state_changed", subject: "run:legacy-run",
      payload: { state }, source_ts: "2026-10-06T00:00:01Z", confidence: "confirmed" });
    const [run] = projectRuns([created, status]);
    assert.equal(run.state, "unknown");
    assert.equal(run.reason, "missing_turn_evidence");
    assert.equal(run.ended_ts, undefined);
  }
});

test("観測の根拠のある running は保ち、根拠が止まると idle になる。最後の根拠の時刻とモデルを残す", () => {
  const run = (state: "running" | "idle", kind: string, ts: string, extra = {}) => fact({ source: "transcript-claude", source_event_id: `${kind}:${ts}`,
    kind: "run.state_changed", subject: "run:c:1", payload: { conversation_id: "c", generation: 1, state,
      last_evidence: { kind, turn_id: ts }, last_evidence_ts: ts, ...extra }, source_ts: ts, confidence: "confirmed" });
  const created = fact({ source: "transcript-claude", source_event_id: "run:c", kind: "run.created", subject: "run:c:1",
    payload: { conversation_id: "c", generation: 1, state: "unknown", reason: "missing_state_evidence", cwd: "/repo", repository_id: "repo" },
    source_ts: "2026-10-07T00:00:00Z", confidence: "confirmed" });
  const started = run("running", "turn_started", "2026-10-07T00:00:01Z");
  const [running] = projectRuns([created, started]);
  assert.equal(running.state, "running");
  assert.equal(running.last_evidence_ts, "2026-10-07T00:00:01Z");
  assert.equal(running.repository_id, "repo");
  const [idle] = projectRuns([started, created, run("idle", "turn_completed", "2026-10-07T00:05:00Z", { model: "claude-test" })]);
  assert.equal(idle.state, "idle");
  assert.equal(idle.last_evidence_ts, "2026-10-07T00:05:00Z");
  assert.equal(idle.model, "claude-test");
});

test("投影の中で組んだ値の未定義の欄は、JSON と同じく省く", () => {
  const value = { attempt: 1, result: undefined, items: [undefined, 2] } as unknown as JsonValue;
  assert.equal(serializeValue(value), '{"attempt":1,"items":[null,2]}');
  assert.deepEqual(JSON.parse(serializeValue(value)), { attempt: 1, items: [null, 2] });
});

test("子のエージェントの SubagentHandback と、SubagentStop と Stop の hook の記録はターンの終わりである", () => {
  assert.equal(classifyClaudeRecord({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: {} }] } })?.state, "idle");
  assert.equal(classifyClaudeRecord({ type: "attachment", uuid: "b", attachment: { type: "hook_success", hookEvent: "SubagentStop" } })?.state, "idle");
  assert.equal(classifyClaudeRecord({ type: "attachment", uuid: "c", attachment: { type: "hook_success", hookEvent: "Stop" } })?.state, "idle");
  assert.equal(classifyClaudeRecord({ type: "attachment", uuid: "d", attachment: { type: "hook_success", hookEvent: "PostToolUse" } }), undefined);
  assert.equal(classifyClaudeRecord({ type: "assistant", uuid: "e", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } })?.state, "running");
});
