export type HistoryProvider = "claude" | "codex";
export interface HistoryKind {
  provider: HistoryProvider;
  type: string;
  field: string;
  subtype: string;
}
export interface HistoryClassification extends HistoryKind {
  action: "ingest" | "ignore";
  handler: string;
  reason: string;
}
function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function readKind(value: unknown): string { return typeof value === "string" ? value : "<missing>"; }
export function identifyHistoryKind(kind: HistoryKind): string {
  return JSON.stringify([kind.provider, kind.type, kind.field, kind.subtype]);
}
/** 本文や識別子には触れず、振り分けに使う種別だけを抽出する。 */
export function extractHistoryKinds(provider: HistoryProvider, value: unknown): HistoryKind[] {
  const row = readObject(value);
  const type = provider === "codex" && row.type === undefined && typeof row.id === "string" && typeof row.timestamp === "string" && row.method === undefined && row.record_type === undefined
    ? "legacy_meta" : readKind(row.type ?? (provider === "codex" ? row.method ?? row.record_type : undefined));
  const kinds: HistoryKind[] = [];
  const add = (field: string, subtype: unknown) => kinds.push({ provider, type, field, subtype: readKind(subtype) });
  if (provider === "claude") {
    if (type === "attachment") {
      const attachment = readObject(row.attachment);
      if (attachment.type === "queued_command") add("attachment.queued_command.commandMode+origin.kind",
        JSON.stringify([readKind(attachment.commandMode), readKind(readObject(attachment.origin).kind)]));
      else add("attachment.type", attachment.type);
    }
    else if (type === "system") add("subtype", row.subtype);
    else if (type === "queue-operation") add("operation", row.operation);
    else add("", "");
    if (row.subtype !== undefined && type !== "system") add("subtype", row.subtype);
    const content = readObject(row.message).content;
    if (Array.isArray(content)) for (const block of content) add("message.content.type", readObject(block).type);
  } else {
    const payload = readObject(row.payload);
    if (type === "event_msg" && ["item_started", "item_completed"].includes(String(payload.type))) {
      add(`payload.${payload.type}.item.type`, readObject(payload.item).type);
    } else if (type === "response_item" && payload.type === "function_call"
      && ["spawn_agent", "send_message", "wait_agent"].includes(String(payload.name))) {
      add("payload.function_call.name", payload.name);
    } else if (type === "response_item" || type === "event_msg") add("payload.type", payload.type);
    else if (type === "item/completed" || type === "item/started") add("params.item.type", readObject(readObject(row.params).item).type);
    else add("", "");
    const content = readObject(row.payload).content;
    if (Array.isArray(content)) for (const block of content) add(`payload.${readKind(readObject(row.payload).type)}.content.type`, readObject(block).type);
  }
  return [...new Map(kinds.filter(kind => !(kind.type === "<missing>" && kind.field === "")).map(kind => [identifyHistoryKind(kind), kind])).values()];
}

// 分類の正本。取り込みは現在の読み手の範囲に限る。
export const HISTORY_CLASSIFICATIONS: HistoryClassification[] = [
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"<missing>","action":"ignore","handler":"ignore","reason":"item の種類のない旧い補助通知は、発言や関係の根拠として保存しない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"<missing>","action":"ignore","handler":"ignore","reason":"item の種類のない旧い補助通知は、発言や関係の根拠として保存しない。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"prompt\",\"human\"]","action":"ingest","handler":"queued-command-user","reason":"利用者の追加入力を保存する。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"prompt\",\"peer\"]","action":"ingest","handler":"queued-command-report","reason":"子の報告を保存する。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"<missing>\",\"coordinator\"]","action":"ingest","handler":"queued-command-user","reason":"親から子への追加指示を子の会話の発言として保存する。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"<missing>\",\"peer\"]","action":"ingest","handler":"queued-command-report","reason":"子の hand-back を報告として保存する。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"task-notification\",\"task-notification\"]","action":"ignore","handler":"ignore","reason":"自動のタスク通知は発言として保存しない。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"task-notification\",\"<missing>\"]","action":"ignore","handler":"ignore","reason":"起源のない旧形式のタスク通知も保存しない。"},
  {"provider":"claude","type":"attachment","field":"attachment.queued_command.commandMode+origin.kind","subtype":"[\"prompt\",\"<missing>\"]","action":"ingest","handler":"queued-command-legacy-user","reason":"旧形式の humanTurn が真の追加入力を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"AgentMessage","action":"ignore","handler":"ignore","reason":"response_item の発言と重複するため捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"UserMessage","action":"ignore","handler":"ignore","reason":"response_item の発言と重複するため捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"CommandExecution","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"Reasoning","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"FileChange","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"Extension","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"ImageView","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"McpToolCall","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"WebSearch","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"ContextCompaction","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"SubAgentActivity","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_started.item.type","subtype":"CollabAgentToolCall","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"AgentMessage","action":"ignore","handler":"ignore","reason":"response_item の発言と重複するため捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"UserMessage","action":"ignore","handler":"ignore","reason":"response_item の発言と重複するため捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"CommandExecution","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"Reasoning","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"FileChange","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"Extension","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"ImageView","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"McpToolCall","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"WebSearch","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"ContextCompaction","action":"ignore","handler":"ignore","reason":"道具または内部処理の記録。現在の読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"SubAgentActivity","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"event_msg","field":"payload.item_completed.item.type","subtype":"CollabAgentToolCall","action":"ignore","handler":"ignore","reason":"対応する response_item がない活動記録。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"response_item","field":"payload.function_call.name","subtype":"spawn_agent","action":"ignore","handler":"ignore","reason":"委譲の操作の証拠。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"response_item","field":"payload.function_call.name","subtype":"send_message","action":"ignore","handler":"ignore","reason":"委譲の操作の証拠。現在は取り込まず、取り込み追加の検討対象とする。"},
  {"provider":"codex","type":"response_item","field":"payload.function_call.name","subtype":"wait_agent","action":"ignore","handler":"ignore","reason":"委譲の操作の証拠。現在は取り込まず、取り込み追加の検討対象とする。"},
  { provider: "codex", type: "response_item", field: "payload.agent_message.content.type", subtype: "input_text", action: "ingest", handler: "message", reason: "agent_message の入力テキストも本文ブロックの一部として保存する。" },
  { provider: "codex", type: "item/started", field: "params.item.type", subtype: "<missing>", action: "ignore", handler: "ignore", reason: "item のない開始通知も完了通知と重複するので捨てる。" },
  {"provider":"claude","type":"agent-name","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"agent-setting","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"ai-title","field":"","subtype":"","action":"ingest","handler":"title","reason":"最新の AI 題名を会話に保存する。"},
  {"provider":"claude","type":"assistant","field":"","subtype":"","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"document","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"fallback","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"image","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"redacted_thinking","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"server_tool_use","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"text","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"thinking","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"tool_result","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"assistant","field":"message.content.type","subtype":"tool_use","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"atis-latch","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"<missing>","action":"ignore","handler":"ignore","reason":"添付の副種別がない旧い補助行は捨てる。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"agent_listing_delta","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"auto_mode_exit","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"auto_mode","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"bash_output_audience_note","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"batching_reminder_sent","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"command_permissions","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"compact_file_reference","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"credential_org","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"date_change","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"date","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"deferred_tools_delta","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"deferred_tools_record","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"edited_text_file","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"environment","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"file","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"hook_blocking_error","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"hook_cancelled","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"hook_non_blocking_error","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"hook_success","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"instructions","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"invoked_skills","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"language","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"model","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"nested_memory","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"plan_file_reference","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"plan_mode_exit","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"plan_mode","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"prompt_snapshot","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"read_truncation_notice","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"remote_session_change","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"sandbox_instructions","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"session_context","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"silent_turn_reminder","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"skill_listing","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"structured_output","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"task_reminder","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"task_status","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"thinking_drop","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"thinking_stripped","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"attachment","field":"attachment.type","subtype":"total_tokens_reminder","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"bridge-session","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"continued-in","field":"","subtype":"","action":"ingest","handler":"relation","reason":"継続または圧縮の関係を保存する。"},
  {"provider":"claude","type":"cost-state","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"custom-title","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"file-history-delta","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"file-history-snapshot","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"isolation-latch","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"隔離の補助情報であり、会話や状態の根拠としては使わない。"},
  {"provider":"claude","type":"last-prompt","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"mode","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"permission-mode","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"pr-link","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"progress","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"queue-operation","field":"operation","subtype":"dequeue","action":"ingest","handler":"queue","reason":"待ち行列の操作を保存する。"},
  {"provider":"claude","type":"queue-operation","field":"operation","subtype":"enqueue","action":"ingest","handler":"queue","reason":"待ち行列の操作を保存する。"},
  {"provider":"claude","type":"queue-operation","field":"operation","subtype":"popAll","action":"ingest","handler":"queue","reason":"待ち行列の操作を保存する。"},
  {"provider":"claude","type":"queue-operation","field":"operation","subtype":"remove","action":"ingest","handler":"queue","reason":"待ち行列の操作を保存する。"},
  {"provider":"claude","type":"relocated","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"summary","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"<missing>","action":"ignore","handler":"ignore","reason":"副種別のない system は補助記録として捨てる。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"api_error","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"away_summary","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"bridge_status","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"compact_boundary","action":"ingest","handler":"relation","reason":"継続または圧縮の関係を保存する。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"informational","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"local_command","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"model_refusal_fallback","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"scheduled_task_fire","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"stop_hook_summary","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"system","field":"subtype","subtype":"turn_duration","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では会話・発言・関係を作らない。"},
  {"provider":"claude","type":"user","field":"","subtype":"","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"document","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"image","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"redacted_thinking","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"server_tool_use","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"text","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"thinking","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"tool_result","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"user","field":"message.content.type","subtype":"tool_use","action":"ingest","handler":"message","reason":"発言の本文ブロックをそのまま保存する。"},
  {"provider":"claude","type":"worktree-state","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"補助情報であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"commandExecution","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"compacted","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"compaction","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"custom_tool_call_output","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"custom_tool_call","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"agent_message","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"agent_reasoning","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"context_compacted","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"error","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"exec_command_begin","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"exec_command_end","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"exec_command_output_delta","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"request_approval","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"task_complete","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"task_completed","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"task_started","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"thread_settings_applied","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"token_count","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"turn_aborted","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"user_message","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"event_msg","field":"payload.type","subtype":"warning","action":"ignore","handler":"ignore","reason":"内部通知または応答行との重複なので捨てる。"},
  {"provider":"codex","type":"fileChange","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"function_call_output","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"function_call","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"inter_agent_communication_metadata","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"item/agentMessage/delta","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"item/commandExecution/requestApproval","field":"","subtype":"","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"agent_message","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"agentMessage","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"collabAgentToolCall","action":"ingest","handler":"delegation","reason":"完了した spawnAgent の親子関係だけを保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"commandExecution","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"compaction","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"custom_tool_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"custom_tool_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"fileChange","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"function_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"function_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"message","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"reasoning","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"tool_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"tool_search_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"userMessage","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"item/completed","field":"params.item.type","subtype":"web_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/fileChange/requestApproval","field":"","subtype":"","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"agent_message","action":"ignore","handler":"ignore","reason":"開始通知は完了通知と重複するので捨てる。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"agentMessage","action":"ignore","handler":"ignore","reason":"開始通知は完了通知と重複するので捨てる。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"collabAgentToolCall","action":"ignore","handler":"ignore","reason":"開始通知は完了通知と重複するので捨てる。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"commandExecution","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"compaction","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"custom_tool_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"custom_tool_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"fileChange","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"function_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"function_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"message","action":"ignore","handler":"ignore","reason":"開始通知は完了通知と重複するので捨てる。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"reasoning","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"tool_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"tool_search_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"userMessage","action":"ignore","handler":"ignore","reason":"開始通知は完了通知と重複するので捨てる。"},
  {"provider":"codex","type":"item/started","field":"params.item.type","subtype":"web_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"legacy_meta","field":"","subtype":"","action":"ingest","handler":"meta","reason":"type のない旧形式のメタから会話と実行を保存する。"},
  {"provider":"codex","type":"message","field":"","subtype":"","action":"ingest","handler":"message","reason":"応答の発言と所属を保存する。"},
  {"provider":"codex","type":"reasoning","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.agent_message.content.type","subtype":"encrypted_content","action":"ingest","handler":"message","reason":"応答の発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.message.content.type","subtype":"input_text","action":"ingest","handler":"message","reason":"応答の発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.message.content.type","subtype":"output_text","action":"ingest","handler":"message","reason":"応答の発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"agent_message","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"agentMessage","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"collabAgentToolCall","action":"ingest","handler":"delegation","reason":"完了した spawnAgent の親子関係だけを保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"commandExecution","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"compaction","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"custom_tool_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"custom_tool_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"fileChange","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"function_call_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"function_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"message","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"reasoning","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"tool_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"tool_search_output","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"userMessage","action":"ingest","handler":"message","reason":"発言と所属を保存する。"},
  {"provider":"codex","type":"response_item","field":"payload.type","subtype":"web_search_call","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"serverRequest/resolved","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"session_meta","field":"","subtype":"","action":"ingest","handler":"meta","reason":"会話のメタと実行を保存する。"},
  {"provider":"codex","type":"state","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"thread/settings/updated","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"thread/started","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"thread/status/changed","field":"","subtype":"","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"thread/tokenUsage/updated","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"token_usage_record","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
  {"provider":"codex","type":"tool_search_call","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"tool_search_output","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"turn_context","field":"","subtype":"","action":"ingest","handler":"model","reason":"モデルと effort の変更を実行に保存する。"},
  {"provider":"codex","type":"turn/completed","field":"","subtype":"","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"turn/started","field":"","subtype":"","action":"ingest","handler":"turn","reason":"ターンと承認の状態の根拠を保存する。"},
  {"provider":"codex","type":"web_search_call","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"道具と内部処理の記録は、この読み手では取り込まない。"},
  {"provider":"codex","type":"world_state","field":"","subtype":"","action":"ignore","handler":"ignore","reason":"内部通知または重複であり、この読み手では事実を作らない。"},
];
const classifications = new Map(HISTORY_CLASSIFICATIONS.map(entry => [identifyHistoryKind(entry), entry]));
export function classifyHistoryKind(kind: HistoryKind): HistoryClassification | undefined {
  return classifications.get(identifyHistoryKind(kind));
}
export function findUnclassifiedKinds(provider: HistoryProvider, row: unknown): HistoryKind[] {
  return extractHistoryKinds(provider, row).filter(kind => !classifyHistoryKind(kind));
}
export function classifyHistoryRow(provider: HistoryProvider, row: unknown): HistoryClassification | undefined {
  const kind = extractHistoryKinds(provider, row)[0];
  return kind ? classifyHistoryKind(kind) : undefined;
}
