import { classifyHistoryRow, findUnclassifiedKinds, identifyHistoryKind } from "../history-kinds.ts";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createFactId, createNativeId, projectConversations, serializeValue } from "../../../../core/src/ledger/index.ts";
import { isClaudeInternalMessage, readClaudeMessageFlags } from "../../../../core/src/ledger/claude-message-flags.ts";
import type { AppendResult, ConversationPayload, FactInput, JsonValue, Ledger, UnsupportedObservationPayload } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../files.ts";
import type { FileCursor, FileRead } from "../files.ts";

export const CLAUDE_QUEUED_COMMANDS_VERSION = 2;
export const CLAUDE_MESSAGE_FLAGS_VERSION = 1;
export const CLAUDE_HISTORY_DETAILS_VERSION = 1;

const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
type Row = { [key: string]: JsonValue };
export interface ClaudeUnsupportedPayload extends UnsupportedObservationPayload {
  record_type: string;
  record_subtype: string | null;
  count: number;
}
type UnsupportedInput = Extract<FactInput, { kind: "observation.unsupported" }> & { payload: ClaudeUnsupportedPayload };
export interface ClaudeObserveOptions {
  cursor?: FileCursor;
  observedTs?: string;
  managed?: boolean;
}
export interface ClaudeObservation extends FileRead {
  modelBackfillLines?: FileRead["lines"];
  appended: number;
  duplicates: number;
  conflicts: AppendResult[];
}
export function readObject(value: JsonValue | undefined): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export function parseRow(text: string): Row | undefined {
  try { return readObject(JSON.parse(text) as JsonValue); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
export function findUnsupportedReason(row: Row | undefined): string | undefined {
  if (!row) return "Invalid JSON object";
  const classification = classifyHistoryRow("claude", row);
  if (classification?.handler.startsWith("queued-command-")) {
    const attachment = readObject(row.attachment)!;
    if (!readString(row.uuid) || !(typeof attachment.prompt === "string" || Array.isArray(attachment.prompt))) {
      return "Unsupported queued command structure";
    }
    if (classification.handler === "queued-command-legacy-user" && (attachment.origin !== undefined || attachment.humanTurn !== true)) {
      return "Missing queued command human origin";
    }
    if (!readQueuedTimestamp(row)) return "Missing or invalid queued command timestamp";
  }
  if (classification?.handler === "structured-output"
    && (!readString(row.uuid) || readObject(row.attachment)?.data === undefined)) return "Unsupported structured output";
  if (row.subtype !== undefined && !(row.type === "system"
    && (row.subtype === "compact_boundary" || classifyHistoryRow("claude", row)?.action === "ignore"))) {
    return "Unsupported record subtype";
  }
  if (row.type === "user" || row.type === "assistant") {
    const message = readObject(row.message);
    if (!readString(row.uuid) || !message || !(typeof message.content === "string" || Array.isArray(message.content))) {
      return "Unsupported message structure";
    }
  } else if (row.type === "queue-operation") {
    if (!readString(row.operation)) return "Missing queue operation";
  } else if (row.type === "continued-in") {
    if (!readString(row.continuedInSessionId)) return "Missing continuation native ID";
  } else if (row.type === "system" && row.subtype === "compact_boundary") {
    if (!readString(row.uuid)) return "Missing compact boundary UUID";
  } else if (row.type === "system" || classifyHistoryRow("claude", row)?.handler === "ignore"
    || classifyHistoryRow("claude", row)?.handler === "title" || row.type === "custom-title" || row.type === "attachment") {
    return undefined;
  } else return "Unsupported record type";
  return undefined;
}
function findUnclassifiedReason(row: Row | undefined): string | undefined {
  if (!row) return undefined;
  const kinds = findUnclassifiedKinds("claude", row);
  return kinds.length ? `Unclassified history kinds: ${kinds.map(identifyHistoryKind).join(", ")}` : undefined;
}
function readQueuedTimestamp(row: Row): string | undefined {
  const attachment = readObject(row.attachment);
  const timestamp = attachment?.timestamp ?? row.timestamp;
  return typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) ? timestamp : undefined;
}
function createUnsupportedEventId(path: string, row: Row | undefined, reason: string): string {
  return JSON.stringify(["unsupported", path, readString(row?.type) ?? "unknown", readString(row?.subtype) ?? null, reason]);
}

export function observeClaudeFile(ledger: Ledger, path: string, options: ClaudeObserveOptions = {}): ClaudeObservation {
  const absolutePath = resolve(path);
  const existing = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const unflaggedMessages = new Set(existing.filter(fact => fact.source === "transcript-claude"
    && fact.kind === "message.created" && !fact.payload?.transcript_flags).map(fact => fact.source_event_id));
  let cursor = options.cursor;
  if (!cursor) {
    for (const fact of existing) {
      if (!fact.cursor || fact.source !== "transcript-claude") continue;
      const saved = JSON.parse(fact.cursor) as FileCursor;
      if (saved.path === absolutePath) cursor = saved;
    }
  }
  const result: ClaudeObservation = { ...readAppendOnlyFile(absolutePath, cursor), appended: 0, duplicates: 0, conflicts: [] };
  // 読み済みの範囲だけを一度補完する。既存の発言の識別子と payload は書き換えない。
  const backfillQueued = cursor && !result.reset && cursor.claudeQueuedCommandsVersion !== CLAUDE_QUEUED_COMMANDS_VERSION;
  const backfillFlags = cursor && cursor.claudeMessageFlagsVersion !== CLAUDE_MESSAGE_FLAGS_VERSION;
  const backfillDetails = cursor && !result.reset && cursor.claudeHistoryDetailsVersion !== CLAUDE_HISTORY_DETAILS_VERSION;
  const backfillLines = backfillQueued || backfillFlags || backfillDetails
    ? result.reset ? result.lines : readAppendOnlyFile(absolutePath).lines.filter(line => line.cursor.offset <= cursor!.offset) : [];
  if (backfillDetails) result.modelBackfillLines = backfillLines.filter(line => parseRow(line.text)?.type === "assistant");
  const versions = { claudeQueuedCommandsVersion: CLAUDE_QUEUED_COMMANDS_VERSION, claudeMessageFlagsVersion: CLAUDE_MESSAGE_FLAGS_VERSION,
    claudeHistoryDetailsVersion: CLAUDE_HISTORY_DETAILS_VERSION };
  result.cursor = { ...result.cursor, ...versions };
  for (const line of result.lines) line.cursor = { ...line.cursor, ...versions };
  const observedTs = options.observedTs ?? new Date().toISOString();
  const nativeId = basename(path, ".jsonl");
  // 子の行の sessionId は親を指すため、ファイルの agent ID を会話の識別に使う。
  const subagent = absolutePath.split(sep).includes("subagents");
  const id = createNativeId("claude", nativeId);
  const queueEventIds = new Set(existing.filter(fact => fact.kind === "conversation.input_queue_changed" && fact.subject === `conversation:${id}`)
    .map(fact => fact.source_event_id));
  const rows = result.lines.filter((line) => line.text.trim()).map((line) => ({ line, row: parseRow(line.text) }));
  // 起源だけを読むため、名前の候補のために本文を投影しない。
  const previous = projectConversations(existing, new Map()).conversations.find((conversation) => conversation.id === id);
  const validRows = rows.filter(({ row }) => !findUnsupportedReason(row)).map(({ row }) => row!);
  const payload: ConversationPayload = {
    provider: "claude", native_id: nativeId, history_format: "jsonl",
    origin: options.managed || previous?.origin === "managed" ? "managed" : "observed",
    type: subagent ? "subagent" : validRows.some((row) => HEADLESS_ENTRYPOINTS.has(String(row.entrypoint)))
      || previous?.type === "unattended" ? "unattended" : "interactive",
  };
  function append(input: FactInput): void {
    const appended = ledger.append(input);
    if (appended.status === "appended") result.appended += 1;
    else if (appended.status === "duplicate") result.duplicates += 1;
    else result.conflicts.push(appended);
  }
  function appendMessageFlags(row: Row, common: Pick<FactInput, "source" | "confidence" | "source_ts" | "observed_ts">): void {
    const messageId = createNativeId("claude", String(row.uuid));
    const flags = readClaudeMessageFlags(row);
    append({ ...common, kind: "message.corrected", subject: `message:${messageId}`,
      source_event_id: `message-flags:v${CLAUDE_MESSAGE_FLAGS_VERSION}:${messageId}:${serializeValue(flags)}`,
      supersedes: createFactId("transcript-claude", `message:${messageId}`),
      payload: { provider: "claude", native_id: String(row.uuid), transcript_flags: flags }, cursor: null });
  }
  function appendQueuedCommand(row: Row, handler: string, checkpoint: string | null): void {
    const attachment = readObject(row.attachment)!;
    const messageId = createNativeId("claude", String(row.uuid));
    const common = { source: "transcript-claude" as const, confidence: "confirmed" as const,
      source_ts: readQueuedTimestamp(row)!, observed_ts: observedTs, cursor: null };
    // 通常の user 行と識別を共有し、出所の識別は分けて既存の payload と衝突させない。
    append({ ...common, kind: "message.created", subject: `message:${messageId}`,
      source_event_id: `queued-command:${messageId}`, payload: { provider: "claude", native_id: String(row.uuid),
        version: 1, role: handler === "queued-command-report" ? "agent_report" : "user", body: attachment.prompt,
        body_state: "stored" } });
    const membershipId = JSON.stringify([messageId, id]);
    append({ ...common, kind: "message_membership.created", subject: `message_membership:${membershipId}`,
      source_event_id: `queued-command-membership:${membershipId}`,
      payload: { message_id: messageId, conversation_id: id, active: true }, cursor: checkpoint });
  }
  // 親は行の sessionId ではなく、子の記録を置いたディレクトリから確定する。
  if (subagent && basename(dirname(absolutePath)) === "subagents") {
    const parent = createNativeId("claude", basename(dirname(dirname(absolutePath))));
    const eventId = `subagent-parent:${id}`;
    if (!existing.some(fact => fact.source_event_id === eventId && fact.source === "transcript-claude")) {
      let metadata: Row = {};
      try { metadata = parseRow(readFileSync(absolutePath.replace(/\.jsonl$/, ".meta.json"), "utf8")) ?? {}; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      append({ source: "transcript-claude", source_event_id: eventId, source_ts: validRows.find(row => typeof row.timestamp === "string")?.timestamp as string ?? previous?.created_ts ?? observedTs,
        observed_ts: observedTs, confidence: "confirmed", kind: "relation.created", subject: `relation:${eventId}`,
        payload: { type: "delegated", from_id: parent, to_id: id, active: true, confidence: "confirmed",
          evidence: { toolUseId: metadata.toolUseId ?? null, description: metadata.description ?? null, agentType: metadata.agentType ?? null } } });
    }
  }
  // 時刻のない題名は観測時刻と行の位置で順序を保つ。再読時は同じ行を追記しない。
  const latestTitle = rows.findLast(({ row }) => row && classifyHistoryRow("claude", row)?.handler === "title" && readString(row.aiTitle)?.trim());
  const unsupported = new Map<string, UnsupportedInput>();
  const knownUnsupported = new Set(existing.filter((fact) => fact.source === "transcript-claude"
    && fact.kind === "observation.unsupported").map((fact) => fact.source_event_id));
  const backfillRows = backfillLines.map(line => ({ line, row: parseRow(line.text), backfill: true }))
    .filter(({ row }) => backfillQueued && classifyHistoryRow("claude", row)?.handler.startsWith("queued-command-")
      || backfillFlags && (row?.type === "user" || row?.type === "assistant") && isClaudeInternalMessage(row)
      || backfillDetails && ["custom-title", "structured-output"].includes(classifyHistoryRow("claude", row)?.handler ?? ""));
  const pendingRows = [...backfillRows, ...rows.map(entry => ({ ...entry, backfill: false }))];
  const customTitle = pendingRows.findLast(({ row }) => row?.type === "custom-title" && readString(row.customTitle)?.trim());
  const hasUnsupported = pendingRows.some(({ row }) => {
    return [findUnsupportedReason(row), findUnclassifiedReason(row)].some(reason =>
      reason !== undefined && !knownUnsupported.has(createUnsupportedEventId(absolutePath, row, reason)));
  });
  for (const { line, row, backfill } of pendingRows) {
    const sourceTs = row && Number.isFinite(Date.parse(String(row.timestamp))) ? String(row.timestamp) : observedTs;
    const common = { source: "transcript-claude" as const, confidence: "confirmed" as const,
      source_ts: sourceTs, observed_ts: observedTs, cursor: hasUnsupported || backfill ? null : JSON.stringify(line.cursor) };
    if (!backfill && !previous && line === rows[0].line) {
      append({ ...common, kind: "conversation.created", subject: `conversation:${id}`,
        source_event_id: `conversation:${id}`, payload, cursor: null });
    } else if (!backfill && previous && (previous.origin !== payload.origin || previous.type !== payload.type) && line === rows[0].line) {
      append({ ...common, kind: "conversation.updated", subject: `conversation:${id}`,
        source_event_id: `conversation:${id}:metadata:${payload.origin}:${payload.type}`, payload, cursor: null });
    }
    if (customTitle && line === pendingRows[0].line) {
      const title = String(customTitle.row!.customTitle).trim();
      const position = customTitle.line.cursor;
      const eventId = `custom-title:${id}:${position.identity}:${String(position.offset).padStart(16, "0")}:${position.hash}`;
      if (previous?.user_name !== title && !existing.some(fact => fact.source === "transcript-claude" && fact.source_event_id === eventId)) {
        append({ source: "transcript-claude", source_event_id: eventId, source_ts: observedTs, observed_ts: observedTs,
          confidence: "confirmed", kind: "conversation.updated", subject: `conversation:${id}`, payload: { user_name: title }, cursor: null });
      }
    }
    if (!backfill && line === rows[0].line && latestTitle) {
      const title = String(latestTitle.row!.aiTitle).trim();
      const eventId = `ai-title:${id}:${latestTitle.line.cursor.identity}:${String(latestTitle.line.cursor.offset).padStart(16, "0")}:${latestTitle.line.cursor.hash}`;
      if (previous?.ai_title !== title && !existing.some(fact => fact.source === "transcript-claude" && fact.source_event_id === eventId)) {
        append({ source: "transcript-claude", source_event_id: eventId, source_ts: observedTs, observed_ts: observedTs,
          confidence: "confirmed", kind: "conversation.updated", subject: `conversation:${id}`, payload: { ai_title: title }, cursor: null });
      }
    }
    const structuralReason = findUnsupportedReason(row);
    for (const reason of [structuralReason, findUnclassifiedReason(row)]) {
      if (!reason) continue;
      const recordType = readString(row?.type) ?? "unknown";
      const recordSubtype = readString(row?.subtype) ?? null;
      const eventId = createUnsupportedEventId(absolutePath, row, reason);
      const group = unsupported.get(eventId);
      if (group) {
        group.payload.count += 1;
      } else {
        unsupported.set(eventId, { ...common, kind: "observation.unsupported",
          subject: `observation:${eventId}`, source_event_id: eventId,
          payload: { source_kind: "transcript-claude", file_path: absolutePath,
            format_name: "claude-jsonl", format_version: "structural", reason,
            record_type: recordType, record_subtype: recordSubtype, count: 1 } });
      }
    }
    if (structuralReason || !row) continue;
    if (backfill && isClaudeInternalMessage(row)) {
      appendMessageFlags(row, common);
      continue;
    }
    const classification = classifyHistoryRow("claude", row);
    if (classification?.handler === "ignore") continue;
    if (classification?.handler.startsWith("queued-command-")) appendQueuedCommand(row, classification.handler, common.cursor);
    if (classification?.handler === "structured-output") {
      const messageId = createNativeId("claude", String(row.uuid));
      append({ ...common, kind: "message.created", subject: `message:${messageId}`, source_event_id: `structured-output:${messageId}`,
        payload: { provider: "claude", native_id: String(row.uuid), version: 1, role: "assistant", phase: "final_answer",
          body: JSON.stringify(readObject(row.attachment)!.data), body_state: "stored" }, cursor: null });
      const membershipId = JSON.stringify([messageId, id]);
      append({ ...common, kind: "message_membership.created", subject: `message_membership:${membershipId}`,
        source_event_id: `structured-output-membership:${membershipId}`, payload: { message_id: messageId, conversation_id: id, active: true } });
    }
    const queueEventId = `input-queue:${id}:${String(line.cursor.offset).padStart(16, "0")}:${line.cursor.hash}`;
    if (classification?.handler === "queue" || row.type === "queue-operation") {
      const eventId = queueEventId;
      if (!queueEventIds.has(eventId)) {
        append({ ...common, kind: "conversation.input_queue_changed", subject: `conversation:${id}`,
          source_event_id: eventId, payload: { input_queue_event: {
            operation: String(row.operation),
            body: row.content,
            ...(readString(row.deliveryId) ? { delivery_id: String(row.deliveryId) } : {}),
          } }, cursor: common.cursor });
        queueEventIds.add(eventId);
      }
    }
    if (classification?.handler === "message") {
      const message = readObject(row.message)!;
      const messageId = createNativeId("claude", String(row.uuid));
      const flags = isClaudeInternalMessage(row);
      const backfillMessage = flags && unflaggedMessages.has(`message:${messageId}`);
      const messagePayload = { provider: "claude" as const, native_id: String(row.uuid), version: 1,
        role: readString(message.role) ?? String(row.type), body: message.content, body_state: "stored" as const,
        ...(flags && !backfillMessage ? { transcript_flags: readClaudeMessageFlags(row) } : {}) };
      append({ ...common, kind: "message.created", subject: `message:${messageId}`,
        source_event_id: `message:${messageId}`, payload: messagePayload, cursor: null });
      // 旧い事実を全行再読しても payload を変えず、同じ訂正で旗を補う。
      if (backfillMessage) appendMessageFlags(row, common);
      // 一行の最後の事実だけに再開位置を載せ、所属の追記前に止まっても読み直せるようにする。
      const membershipId = JSON.stringify([messageId, id]);
      append({ ...common, kind: "message_membership.created", subject: `message_membership:${membershipId}`,
        source_event_id: `membership:${membershipId}`, payload: { message_id: messageId, conversation_id: id, active: true } });
    } else if (classification?.handler === "relation") {
      const type = row.type === "continued-in" ? "continued" : "compacted";
      const target = type === "continued" ? createNativeId("claude", String(row.continuedInSessionId)) : id;
      const evidence: JsonValue = type === "continued"
        ? { sessionId: nativeId, continuedInSessionId: String(row.continuedInSessionId) }
        : { uuid: row.uuid ?? null, logicalParentUuid: row.logicalParentUuid ?? null,
          compactMetadata: row.compactMetadata ?? null };
      const relationId = JSON.stringify([type, id, target, serializeValue(evidence)]);
      append({ ...common, kind: "relation.created", subject: `relation:${relationId}`, source_event_id: `relation:${relationId}`,
        payload: { type, from_id: id, to_id: target, confidence: "confirmed", active: true, evidence } });
    }
  }
  // 台帳は不変なので、count は初回の読み取り範囲の件数を保ち、追記分は加算しない。
  const lastUnsupportedId = [...unsupported.keys()].filter((eventId) => !knownUnsupported.has(eventId)).at(-1);
  for (const [eventId, input] of unsupported) {
    if (knownUnsupported.has(eventId)) {
      result.duplicates += 1;
      continue;
    }
    // 全組の保存前には cursor を進めず、中断時に未保存の行も読み直す。
    if (eventId === lastUnsupportedId) input.cursor = JSON.stringify(result.cursor);
    append(input);
  }
  return result;
}

export function observeClaudeProjects(
  ledger: Ledger, projectsPath = join(homedir(), ".claude", "projects"), options: Omit<ClaudeObserveOptions, "cursor"> = {},
): ClaudeObservation[] {
  const results: ClaudeObservation[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(observeClaudeFile(ledger, path, options));
    }
  }
  visit(projectsPath);
  return results;
}
