import type { Fact, JsonValue, RunPayload, RunState } from "./facts.ts";

/**
 * 外の会話の状態の規則。観測と hook と投影は、この 1 か所の規則だけで状態を決める。
 * - running は、進行中のターンの根拠があるときだけにする
 * - 根拠のターンが止まったら idle にする
 * - ended は観測の記録の終わりの印だけで決め、時間からは推定しない
 */
/**
 * 状態の規則の版。規則を変えて同じ記録の行の読み方が変わるときに上げる。
 * 台帳は追記だけなので、行の事実の識別子に版を入れ、新しい読み方を新しい事実として足す。
 */
export const TURN_RULE_VERSION = 2;
export type TurnEvidenceKind =
  | "turn_started" | "tool_call" | "tool_result" | "request_approval"
  | "turn_completed" | "turn_interrupted" | "thread_status";
export interface TurnEvidence {
  state: Extract<RunState, "running" | "idle" | "waiting_approval" | "unknown">;
  kind: TurnEvidenceKind;
  // ターンや記録の識別。根拠の表示と再読の照合に使う。
  turn_id?: string | null;
  // 観測した記録に書かれたモデル。起動の設定とは別に持つ。
  model?: string;
}
type Row = { [key: string]: JsonValue };

function readObject(value: JsonValue | undefined): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// 利用者の端末の操作で、エージェントのターンを起こさない記録。
const LOCAL_MARKERS = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input)>/u;
const INTERRUPT_MARKER = /^\[Request interrupted by user(?: for tool use)?\]/u;
// assistant の応答の止まり方のうち、ターンの続きを待たないもの。
const FINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal", "model_context_window_exceeded"]);

function blocks(content: JsonValue | undefined): Row[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.map((block) => readObject(block)) : [];
}
function blockText(block: Row): string {
  return typeof block.text === "string" ? block.text : typeof block.content === "string" ? block.content : "";
}

/**
 * Claude Code の会話の記録 1 行を、ターンの根拠に読み替える。根拠にならない行は undefined を返す。
 * 最後の記録が利用者の発言か道具の呼び出しで、assistant の最終の応答が来ていなければ running である。
 */
export function classifyClaudeRecord(row: Row): TurnEvidence | undefined {
  const turnId = readText(row.uuid) ?? null;
  if (row.type === "attachment") {
    // 子のエージェントが手を戻したときと、ターンが止まったときの hook の記録は、ターンの終わりの印である。
    const hook = readText(readObject(row.attachment).hookEvent);
    return hook === "SubagentStop" || hook === "Stop" ? { state: "idle", kind: "turn_completed", turn_id: turnId } : undefined;
  }
  if (row.type === "system") {
    // ターンの所要時間の記録は、ターンが終わった印である。
    return row.subtype === "turn_duration" ? { state: "idle", kind: "turn_completed", turn_id: turnId } : undefined;
  }
  if (row.type !== "user" && row.type !== "assistant") return undefined;
  if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return undefined;
  const message = readObject(row.message);
  const content = blocks(message.content);
  if (row.type === "user") {
    if (content.some((block) => INTERRUPT_MARKER.test(blockText(block)))) {
      return { state: "idle", kind: "turn_interrupted", turn_id: turnId };
    }
    if (content.some((block) => block.type === "tool_result")) return { state: "running", kind: "tool_result", turn_id: turnId };
    const text = content.map(blockText).join("\n").trim();
    if (!text && !content.some((block) => block.type === "image" || block.type === "document")) return undefined;
    if (LOCAL_MARKERS.test(text)) return undefined;
    return { state: "running", kind: "turn_started", turn_id: turnId };
  }
  const model = readText(message.model);
  const observed = model && model !== "<synthetic>" ? { model } : {};
  // 子のエージェントは SubagentHandback で親へ結果を返して終わる。
  if (content.some((block) => block.type === "tool_use" && block.name === "SubagentHandback")) {
    return { state: "idle", kind: "turn_completed", turn_id: turnId, ...observed };
  }
  if (content.some((block) => block.type === "tool_use" || block.type === "server_tool_use")) {
    return { state: "running", kind: "tool_call", turn_id: turnId, ...observed };
  }
  const stop = readText(message.stop_reason);
  if (stop && FINAL_STOP_REASONS.has(stop)) return { state: "idle", kind: "turn_completed", turn_id: turnId, ...observed };
  if (stop === "tool_use" || stop === "pause_turn") return { state: "running", kind: "tool_call", turn_id: turnId, ...observed };
  // 止まり方を書かない旧い版では、本文だけの応答を最終の応答とみなす。思考だけの行は途中である。
  if (!stop && content.some((block) => block.type === "text" && blockText(block).trim())) {
    return { state: "idle", kind: "turn_completed", turn_id: turnId, ...observed };
  }
  return { state: "running", kind: "tool_call", turn_id: turnId, ...observed };
}

/** Codex の rollout の 1 行を、ターンの根拠に読み替える。turn の開始があり completed がなければ running である。 */
export function classifyCodexRecord(row: Row): TurnEvidence | undefined {
  const method = readText(row.method);
  const payload = readObject(row.payload);
  const params = readObject(row.params);
  const eventType = row.type === "event_msg" ? readText(payload.type) : undefined;
  const turnId = (readText(params.turnId) ?? readText(readObject(params.turn).id) ?? readText(payload.turn_id)) ?? null;
  if (method === "turn/started" || eventType === "task_started") return { state: "running", kind: "turn_started", turn_id: turnId };
  if (method === "turn/completed" || eventType === "task_complete" || eventType === "task_completed") {
    return { state: "idle", kind: "turn_completed", turn_id: turnId };
  }
  if (eventType === "turn_aborted") return { state: "idle", kind: "turn_interrupted", turn_id: turnId };
  if (method === "thread/status/changed") {
    const status = readObject(params.status);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const state = flags.includes("waitingOnApproval") ? "waiting_approval" : status.type === "active" ? "running"
      : status.type === "idle" ? "idle" : "unknown";
    return { state, kind: "thread_status", turn_id: turnId };
  }
  if (method?.endsWith("/requestApproval") || eventType === "request_approval") {
    return { state: "waiting_approval", kind: "request_approval", turn_id: (readText(row.id) ?? readText(payload.request_id)) ?? null };
  }
  return undefined;
}

/** Codex の turn_context に書かれたモデルと effort を読む。 */
export function readCodexTurnModel(row: Row): { model?: string; effort?: string } {
  if (row.type !== "turn_context") return {};
  const payload = readObject(row.payload);
  const model = readText(payload.model);
  const effort = readText(payload.effort) ?? readText(readObject(payload.reasoning).effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** Claude Code の hook の出来事を、ターンの根拠に読み替える。終了は SessionEnd の根拠表で別に扱う。 */
export function classifyHookEvent(name: string): TurnEvidence | undefined {
  if (name === "UserPromptSubmit") return { state: "running", kind: "turn_started" };
  if (name === "Stop") return { state: "idle", kind: "turn_completed" };
  return undefined;
}

const TURN_KINDS = new Set<string>(["turn_started", "tool_call", "tool_result", "request_approval",
  "turn_completed", "turn_interrupted", "thread_status"]);

/** 状態の根拠が、進行中のターンを示す記録かを判定する。 */
export function isTurnEvidence(evidence: JsonValue | undefined): boolean {
  const value = readObject(evidence);
  if (typeof value.kind === "string" && TURN_KINDS.has(value.kind)) return true;
  return typeof value.hook_event_name === "string" && classifyHookEvent(value.hook_event_name) !== undefined;
}

const LIVE_STATES = new Set<RunState>(["running", "waiting_approval", "waiting_input"]);

/**
 * 旧い daemon の状態は、ターンの観測ではなく常駐の確認である。
 * ターンの根拠がない live な状態を不明に置き換え、その理由を返す。置き換えないときは undefined を返す。
 */
export function rejectUnobservedLiveState(fact: Fact): string | undefined {
  if (fact.source !== "legacy") return undefined;
  const payload = (fact.payload ?? {}) as Partial<RunPayload>;
  if (!payload.state || !LIVE_STATES.has(payload.state)) return undefined;
  return isTurnEvidence(payload.last_evidence) ? undefined : "missing_turn_evidence";
}
