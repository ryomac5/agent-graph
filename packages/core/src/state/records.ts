import type { Evidence, Signal, StateEvidence } from "./types.ts";

type Row = Record<string, unknown>;
export interface NativeRecord extends Evidence {
  source: "claude" | "hook" | "codex" | "claude_sdk" | "claude_child" | "codex_child" | "claude_session";
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
function readBoolean(value: unknown): boolean | undefined { return value === true || value === "true" ? true : value === false || value === "false" ? false : undefined; }
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
  if (source === "claude" && (row.isMeta === true || row.isCompactSummary === true || row.isVisibleInTranscriptOnly === true)) return [];
  if (source === "claude_session") {
    if (row.status !== "busy" || typeof row.statusUpdatedAt !== "number" || !Number.isFinite(row.statusUpdatedAt) ||
      typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0 || !readString(row.procStart)) return [];
    return emit("progress").map(signal => ({ ...signal, at: row.statusUpdatedAt as number,
      activity: "session_busy", process: { pid: row.pid as number, procStart: row.procStart as string } }));
  }
  const attachment = readObject(row.attachment);
  if (source === "hook" || source === "claude" && row.type === "attachment") {
    const hook = source === "hook" ? row.hook_event_name : attachment.hookEvent;
    const toolId = readString(source === "hook" ? row.tool_use_id : attachment.toolUseID) ?? null;
    const notifications: Record<string, Signal["event"][]> = { permission_prompt: ["approval"], idle_prompt: ["stop_attempt"] };
    const events: Record<string, Signal["event"][]> = { Stop: ["stop_attempt"], SubagentStop: ["stop_attempt"],
      PreToolUse: [source === "hook" && row.tool_name === "AskUserQuestion" ? "input" : "progress"], PostToolUse: ["progress"],
      ...(source === "hook" ? { SessionStart: ["open"], UserPromptSubmit: ["start"], SessionEnd: ["close"],
        Notification: notifications[String(row.notification_type)] ?? [] } : {}) };
    return emit(...(events[String(hook)] ?? [])).map(signal => signal.event === "progress" && (hook === "PreToolUse" || hook === "PostToolUse")
      ? { ...signal, tools: [{ id: toolId, phase: hook === "PreToolUse" ? "started" : "finished" }] } : signal);
  }
  if (source === "claude_child") {
    const text = row.type === "queue-operation" && row.operation === "enqueue" ? readString(row.content)
      : row.type === "user" ? blocks.filter(b => b.type === "text").map(b => b.text).join("\n") : undefined;
    const notification = text?.trim().match(/^<task-notification>\s*<task-id>([^<]+)<\/task-id>([\s\S]*?)<\/task-notification>$/u);
    if (notification && record.childId && notification[1] === record.childId) {
      const status = notification[2].match(/<status>(stopped|completed)<\/status>/u)?.[1];
      return status === "stopped" ? emit("child_stopped") : status === "completed" ? emit("complete") : [];
    }
    const result = readObject(row.toolUseResult);
    const call = readBlocks(readObject(record.parentCall?.message).content).find(b => b.name === "Agent" && blocks.some(r => r.type === "tool_result" && r.tool_use_id === b.id));
    if (!call || !record.childId || result.agentId !== record.childId) return [];
    if (result.status === "async_launched" && readBoolean(result.isAsync) === true) return emit("launched");
    if (result.status === "completed" && readBoolean(result.isAsync) !== true && readBoolean(readObject(call.input).run_in_background) === false &&
      readBlocks(result.content).some(b => b.type === "text" && readString(b.text))) return emit("responded", "complete");
    return [];
  }
  if (source === "codex_child") {
    const payload = readObject(row.payload), activity = readObject(payload.item);
    if (payload.type === "item_completed" && activity.type === "SubAgentActivity" && record.childId && activity.agent_thread_id === record.childId) {
      return activity.kind === "completed" ? emit("complete") : activity.kind === "started" ? emit("launched") : [];
    }
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
    if (row.type === "system" && row.subtype === "session_state_changed") {
      if (row.state === "idle") return emit("complete");
      if (row.state === "running") return emit("progress");
      if (row.state === "requires_action") return emit("approval");
    }
    return [];
  }
  if (source === "claude") {
    if (row.type === "system") return row.subtype === "turn_duration" ? emit("complete") : [];
    if (row.type === "user") {
      if (blocks.some(b => b.type === "tool_result")) {
        const handback = readBlocks(readObject(record.parentCall?.message).content).find(b => b.name === "SubagentHandback" && blocks.some(r => r.tool_use_id === b.id));
        const result = readObject(row.toolUseResult);
        const signals = handback && typeof result.success === "boolean" ? emit("progress", result.success ? "reported" : "report_failure") : emit("progress");
        return signals.map(signal => signal.event === "progress" ? { ...signal, tools: blocks.filter(b => b.type === "tool_result")
          .map(b => ({ id: readString(b.tool_use_id) ?? null, phase: "finished" as const })) } : signal);
      }
      const text = blocks.map(b => typeof b.text === "string" ? b.text : "").join("\n").trim();
      if (/^\[Request interrupted by user(?: for tool use)?\]/u.test(text)) return emit("complete", "interrupted");
      if (/^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input)>/u.test(text)) return [];
      return text || blocks.some(b => b.type === "image" || b.type === "document") ? emit("start") : [];
    }
    if (row.type === "assistant") {
      const tools = blocks.filter(b => b.type === "tool_use" || b.type === "server_tool_use");
      if (tools.some(b => b.type === "tool_use" && b.name === "AskUserQuestion")) return emit("input");
      if (tools.length || message.stop_reason === "tool_use" || message.stop_reason === "pause_turn") return emit("progress").map(signal => ({ ...signal,
        tools: tools.map(b => ({ id: readString(b.id) ?? null, phase: "started" as const })) }));
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
  if (row.type === "response_item" && ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(item.type))) {
    return emit("progress").map(signal => ({ ...signal, tools: [{ id: readString(item.call_id) ?? null,
      phase: String(item.type).endsWith("_output") ? "finished" : "started" }] }));
  }
  if ((event === "item/started" || event === "item/completed") && ["commandExecution", "mcpToolCall", "collabAgentToolCall"].includes(String(item.type))) {
    return emit("progress").map(signal => ({ ...signal, tools: [{ id: readString(item.id) ?? null,
      phase: event === "item/completed" ? "finished" : "started" }] }));
  }
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
