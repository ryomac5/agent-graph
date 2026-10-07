import { readdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createNativeId, projectConversations, serializeValue } from "../../../../core/src/ledger/index.ts";
import type { AppendResult, ConversationPayload, FactInput, JsonValue, Ledger, UnsupportedObservationPayload } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../files.ts";
import type { FileCursor, FileRead } from "../files.ts";

const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
const IGNORED_TYPES = new Set(["file-history-snapshot", "queue-operation", "progress", "summary",
  "custom-title", "agent-name", "last-prompt", "pr-link", "attachment", "ai-title",
  "permission-mode", "mode", "atis-latch", "cost-state", "file-history-delta", "bridge-session",
  "agent-setting", "relocated", "worktree-state"]);
const IGNORED_SYSTEM_SUBTYPES = new Set(["api_error", "away_summary", "bridge_status", "informational",
  "local_command", "model_refusal_fallback", "scheduled_task_fire", "stop_hook_summary", "turn_duration"]);
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
  appended: number;
  duplicates: number;
  conflicts: AppendResult[];
}
function readObject(value: JsonValue | undefined): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function parseRow(text: string): Row | undefined {
  try { return readObject(JSON.parse(text) as JsonValue); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}
function findUnsupportedReason(row: Row | undefined): string | undefined {
  if (!row) return "Invalid JSON object";
  if (row.subtype !== undefined && !(row.type === "system"
    && (row.subtype === "compact_boundary" || IGNORED_SYSTEM_SUBTYPES.has(String(row.subtype))))) {
    return "Unsupported record subtype";
  }
  if (row.type === "user" || row.type === "assistant") {
    const message = readObject(row.message);
    if (!readString(row.uuid) || !message || !(typeof message.content === "string" || Array.isArray(message.content))) {
      return "Unsupported message structure";
    }
  } else if (row.type === "continued-in") {
    if (!readString(row.continuedInSessionId)) return "Missing continuation native ID";
  } else if (row.type === "system" && row.subtype === "compact_boundary") {
    if (!readString(row.uuid)) return "Missing compact boundary UUID";
  } else if (row.type === "system" || IGNORED_TYPES.has(String(row.type))) {
    return undefined;
  } else return "Unsupported record type";
  return undefined;
}
function createUnsupportedEventId(path: string, row: Row | undefined, reason: string): string {
  return JSON.stringify(["unsupported", path, readString(row?.type) ?? "unknown", readString(row?.subtype) ?? null, reason]);
}

export function observeClaudeFile(ledger: Ledger, path: string, options: ClaudeObserveOptions = {}): ClaudeObservation {
  const absolutePath = resolve(path);
  const existing = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  let cursor = options.cursor;
  if (!cursor) {
    for (const fact of existing) {
      if (!fact.cursor || fact.source !== "transcript-claude") continue;
      const saved = JSON.parse(fact.cursor) as FileCursor;
      if (saved.path === absolutePath) cursor = saved;
    }
  }
  const result: ClaudeObservation = { ...readAppendOnlyFile(absolutePath, cursor), appended: 0, duplicates: 0, conflicts: [] };
  const observedTs = options.observedTs ?? new Date().toISOString();
  const nativeId = basename(path, ".jsonl");
  // 子の行の sessionId は親を指すため、ファイルの agent ID を会話の識別に使う。
  const subagent = absolutePath.split(sep).includes("subagents");
  const id = createNativeId("claude", nativeId);
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
  const unsupported = new Map<string, UnsupportedInput>();
  const knownUnsupported = new Set(existing.filter((fact) => fact.source === "transcript-claude"
    && fact.kind === "observation.unsupported").map((fact) => fact.source_event_id));
  const hasUnsupported = rows.some(({ row }) => {
    const reason = findUnsupportedReason(row);
    return reason !== undefined && !knownUnsupported.has(createUnsupportedEventId(absolutePath, row, reason));
  });
  for (const { line, row } of rows) {
    const sourceTs = row && Number.isFinite(Date.parse(String(row.timestamp))) ? String(row.timestamp) : observedTs;
    const common = { source: "transcript-claude" as const, confidence: "confirmed" as const,
      source_ts: sourceTs, observed_ts: observedTs, cursor: hasUnsupported ? null : JSON.stringify(line.cursor) };
    if (!previous && line === rows[0].line) {
      append({ ...common, kind: "conversation.created", subject: `conversation:${id}`,
        source_event_id: `conversation:${id}`, payload, cursor: null });
    } else if (previous && (previous.origin !== payload.origin || previous.type !== payload.type) && line === rows[0].line) {
      append({ ...common, kind: "conversation.updated", subject: `conversation:${id}`,
        source_event_id: `conversation:${id}:metadata:${payload.origin}:${payload.type}`, payload, cursor: null });
    }
    const reason = findUnsupportedReason(row);
    if (reason) {
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
      continue;
    }
    if (!row) continue;
    if (row.type === "user" || row.type === "assistant") {
      const message = readObject(row.message)!;
      const messageId = createNativeId("claude", String(row.uuid));
      const messagePayload = { provider: "claude" as const, native_id: String(row.uuid), version: 1,
        role: readString(message.role) ?? String(row.type), body: message.content, body_state: "stored" as const };
      append({ ...common, kind: "message.created", subject: `message:${messageId}`,
        source_event_id: `message:${messageId}`, payload: messagePayload, cursor: null });
      // 一行の最後の事実だけに再開位置を載せ、所属の追記前に止まっても読み直せるようにする。
      const membershipId = JSON.stringify([messageId, id]);
      append({ ...common, kind: "message_membership.created", subject: `message_membership:${membershipId}`,
        source_event_id: `membership:${membershipId}`, payload: { message_id: messageId, conversation_id: id, active: true } });
    } else if (row.type === "continued-in" || (row.type === "system" && row.subtype === "compact_boundary")) {
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
