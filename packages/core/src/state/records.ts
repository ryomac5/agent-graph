import type { Evidence, Signal, StateEvidence } from "./types.ts";

type Row = Record<string, unknown>;
export interface NativeRecord extends Evidence {
  source: "claude" | "hook" | "codex" | "claude_sdk" | "claude_child" | "codex_child";
  runId: string;
  row: Row;
  // native の相関がない場合だけ、外部で確かめた対応を渡す。現在の turn で補わない。
  turnId?: string | null;
  attemptId?: string | null;
  interruptId?: string;
  childId?: string;
  parentCall?: Row;
}

function readObject(value: unknown): Row { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function readString(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function readBlocks(value: unknown): Row[] { return Array.isArray(value) ? value.map(readObject) : typeof value === "string" ? [{ type: "text", text: value }] : []; }

function readNativeTurnIds(source: NativeRecord["source"], row: Row): string[] {
  const params = readObject(row.params);
  const payload = readObject(row.payload);
  const ids = source === "hook" ? [row.prompt_id] : source === "claude" ? [row.promptId]
    : source === "codex" ? [payload.turn_id, params.turnId, readObject(params.turn).id, readObject(readObject(row.result).turn).id] : [];
  return [...new Set(ids.map(readString).filter(id => id !== undefined))];
}

export function readNativeTurnId(source: NativeRecord["source"], row: Row): string | null {
  const unique = readNativeTurnIds(source, row);
  return unique.length === 1 ? unique[0] : null;
}

function readNativeSignals(record: NativeRecord): Signal[] {
  const { row, source } = record;
  const turnIds = [...new Set([...readNativeTurnIds(source, row), ...(record.turnId ? [record.turnId] : [])])];
  const turnId = turnIds.length === 1 ? turnIds[0] : null;
  const emit = (...events: Signal["event"][]): Signal[] => events.map(event => ({
    id: `${record.id}:${event}`, at: record.at, observedAt: record.observedAt,
    kind: "signal", runId: record.runId, turnId, attemptId: record.attemptId,
    interruptId: record.interruptId, event,
  }));
  const message = readObject(row.message);
  const blocks = readBlocks(message.content);
  if (source === "hook") {
    const events: Record<string, Signal["event"][]> = { SessionStart: ["open"], UserPromptSubmit: ["start"], Stop: ["stop_attempt"], SubagentStop: ["stop_attempt"], SessionEnd: ["close"] };
    return emit(...(events[String(row.hook_event_name)] ?? []));
  }
  if (source === "claude_child") {
    const result = readObject(row.toolUseResult);
    const call = readBlocks(readObject(record.parentCall?.message).content).find(b => b.name === "Agent" && blocks.some(r => r.type === "tool_result" && r.tool_use_id === b.id));
    if (!call || !record.childId || result.agentId !== record.childId) return [];
    if (result.status === "async_launched" && result.isAsync === true) return emit("launched");
    if (result.status === "completed" && result.isAsync !== true && readObject(call.input).run_in_background === false &&
      readBlocks(result.content).some(b => b.type === "text" && readString(b.text))) return emit("responded", "complete");
    return [];
  }
  if (source === "codex_child") {
    const item = readObject(readObject(row.params).item);
    if (row.method !== "item/completed" || item.type !== "collabAgentToolCall" || item.status !== "completed" ||
      !record.childId || !Array.isArray(item.receiverThreadIds) || !item.receiverThreadIds.includes(record.childId)) return [];
    if (item.tool === "spawnAgent") return emit("launched");
    // wait の子ごとの completed と応答が揃い、依頼への対応が渡された場合だけ応答済みにする。
    const child = readObject(readObject(item.agentsStates)[record.childId]);
    if (item.tool === "wait" && child.status === "completed" && readString(child.message) && record.attemptId) return emit("responded");
    return [];
  }
  if (source === "claude_sdk") {
    if (row.type === "result") return emit("complete", row.is_error === false ? "responded" : row.is_error === true ? "failure" : "stop_attempt");
    if (row.type === "system" && row.subtype === "session_state_changed" && row.state === "idle") return emit("complete");
    return [];
  }
  if (source === "claude") {
    if (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true) return [];
    if (row.type === "system") return row.subtype === "turn_duration" ? emit("complete") : [];
    if (row.type === "attachment") {
      const hook = readObject(row.attachment).hookEvent;
      return hook === "Stop" || hook === "SubagentStop" ? emit("stop_attempt") : [];
    }
    if (row.type === "user") {
      if (blocks.some(b => b.type === "tool_result")) {
        const handback = readBlocks(readObject(record.parentCall?.message).content).find(b => b.name === "SubagentHandback" && blocks.some(r => r.tool_use_id === b.id));
        const result = readObject(row.toolUseResult);
        return handback && typeof result.success === "boolean" ? emit("progress", result.success ? "reported" : "report_failure") : emit("progress");
      }
      const text = blocks.map(b => typeof b.text === "string" ? b.text : "").join("\n").trim();
      if (/^\[Request interrupted by user(?: for tool use)?\]/u.test(text)) return emit("complete", "interrupted");
      if (/^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input)>/u.test(text)) return [];
      return text || blocks.some(b => b.type === "image" || b.type === "document") ? emit("start") : [];
    }
    if (row.type === "assistant") {
      if (blocks.some(b => b.type === "tool_use" || b.type === "server_tool_use") || message.stop_reason === "tool_use" || message.stop_reason === "pause_turn") return emit("progress");
      if (["end_turn", "stop_sequence", "max_tokens", "refusal", "model_context_window_exceeded"].includes(String(message.stop_reason))) return emit("stop_attempt");
      return blocks.length ? emit("progress") : [];
    }
    return [];
  }
  const params = readObject(row.params);
  const payload = readObject(row.payload);
  const event = row.type === "event_msg" ? payload.type : row.method;
  if (event === "task_started" || event === "turn/started") return emit("start");
  if (event === "item_completed") return emit("progress");
  if (event === "task_complete" || event === "task_completed" || event === "turn/completed") {
    const status = readObject(params.turn).status;
    return status === "failed" ? emit("complete", "failure") : status === "interrupted" ? emit("complete", "interrupted") : emit("complete");
  }
  if (event === "turn_aborted") return emit("complete", "interrupted");
  if (event === "thread/closed") return emit("close");
  if (typeof event === "string" && (event.endsWith("/requestApproval") || event === "request_approval")) return emit("approval");
  if (event === "thread/status/changed") {
    const status = readObject(params.status);
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    return flags.includes("waitingOnApproval") ? emit("approval") : flags.includes("waitingOnUserInput") ? emit("input") : status.type === "active" ? emit("progress") : [];
  }
  const item = row.type === "response_item" ? payload : readObject(params.item);
  if (row.type === "response_item" || event === "item/completed" || event === "item/started" || event === "item/agentMessage/delta") {
    return (row.type === "response_item" || event === "item/completed") && item.phase === "final_answer" &&
      (item.type === "agentMessage" || item.type === "message" && item.role === "assistant") ? emit("progress", "responded") : emit("progress");
  }
  return [];
}

export function readNativeEvidence(record: NativeRecord): StateEvidence[] {
  const signals = readNativeSignals(record);
  // 訂正後に状態の根拠がなくなる場合も、旧い根拠の撤回自体を失わない。
  return record.supersedes?.length ? [...signals, {
    kind: "unavailable", id: `${record.id}:correction`, runId: record.runId,
    at: record.at, observedAt: record.observedAt, supersedes: record.supersedes,
  }] : signals;
}
