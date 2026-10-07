import { basename, resolve } from "node:path";
import { classifyClaudeRecord, createNativeId, projectConversations, TURN_RULE_VERSION } from "../../../../core/src/ledger/index.ts";
import type { AppendResult, Fact, FactInput, Ledger, RunPayload } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile, type FileLine } from "../files.ts";
import { defaultLocationResolver, type LocationResolver, type ObservedLocation } from "../location.ts";
import { findUnsupportedReason, parseRow } from "./index.ts";

/** 会話の場所の事実の識別。これがあれば、場所とターンの根拠を読み終えている。 */
export function claudeLocationEventId(conversationId: string): string {
  return `conversation:${conversationId}:location`;
}
/** 会話の記録のファイルから、会話の識別を決める。子のファイルもファイル名の ID を使う。 */
export function claudeConversationId(path: string): string {
  return createNativeId("claude", basename(path, ".jsonl"));
}

export interface ClaudeContextOptions {
  /** 発言の取り込みで読んだ行。先頭から読んだときは fromStart を真にする。 */
  lines?: FileLine[];
  fromStart?: boolean;
  observedTs?: string;
  locate?: LocationResolver;
}
export interface ClaudeContextResult { appended: number; duplicates: number; conflicts: AppendResult[] }
type TurnTarget = { subject: string; generation: number; started: number };

/**
 * 会話の記録から、会話の場所とターンの根拠を追記する。状態の決め方は core の規則に従い、状態が変わる行だけを事実にする。
 * 根拠は hook の実行のうち行より前に始まったものに結び、なければ会話の記録の実行を作る。
 * 場所の事実がまだない会話は、以前に読んだ範囲も含めて一度だけ先頭から読む。
 * 管理する実行の状態はホストが正本なので、管理する会話からは場所だけを読む。
 */
export function observeClaudeContext(ledger: Ledger, path: string, options: ClaudeContextOptions = {}): ClaudeContextResult {
  const absolutePath = resolve(path);
  const nativeId = basename(absolutePath, ".jsonl");
  const id = claudeConversationId(absolutePath);
  const hookConversation = `claude:${nativeId}`;
  const existing = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const observedTs = options.observedTs ?? new Date().toISOString();
  const result: ClaudeContextResult = { appended: 0, duplicates: 0, conflicts: [] };
  function append(input: FactInput): void {
    const appended = ledger.append(input);
    if (appended.status === "appended") result.appended += 1;
    else if (appended.status === "duplicate") result.duplicates += 1;
    else result.conflicts.push(appended);
  }
  const belongs = (fact: Fact) => {
    const conversation = (fact.payload as Partial<RunPayload> | null)?.conversation_id;
    return conversation === id || conversation === hookConversation;
  };
  const conversation = projectConversations(existing.filter((fact) => fact.kind.startsWith("conversation.")))
    .conversations.find((row) => row.id === id);
  const turns = conversation?.origin !== "managed";
  const locationId = claudeLocationEventId(id);
  let located = existing.some((fact) => fact.source === "transcript-claude" && fact.source_event_id === locationId);
  const states = new Map<string, string>();
  let own: TurnTarget | undefined;
  const hooks: TurnTarget[] = [];
  for (const fact of existing) {
    if (!fact.kind.startsWith("run.") || !fact.payload || !belongs(fact)) continue;
    const payload = fact.payload as Partial<RunPayload>;
    if (fact.source === "transcript-claude" && fact.kind === "run.created" && typeof payload.generation === "number") {
      own = { subject: fact.subject, generation: payload.generation, started: payload.generation };
    }
    if (fact.source === "transcript-claude" && fact.kind === "run.state_changed" && payload.state) states.set(fact.subject, payload.state);
    if (fact.source === "hook" && fact.kind === "run.created" && typeof payload.generation === "number") {
      const started = Date.parse(payload.started_ts ?? fact.source_ts);
      if (Number.isFinite(started)) hooks.push({ subject: fact.subject, generation: payload.generation, started });
    }
  }
  // 以前に読んだ範囲の根拠がまだ無い会話は、一度だけ先頭から読み直す。発言は重ねて追記しない。
  let lines: FileLine[];
  if (located && options.lines) lines = options.lines;
  else if (!located && options.lines && options.fromStart) lines = options.lines;
  else {
    try { lines = readAppendOnlyFile(absolutePath).lines; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return result;
      throw error;
    }
  }
  let location: ObservedLocation | undefined;
  // 場所なしの印の時刻は最初の発言の時刻にし、読む側によらず同じ事実にする。
  let firstMessageTs: string | undefined;
  const locate = options.locate ?? defaultLocationResolver;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    const row = parseRow(line.text);
    if (!row || findUnsupportedReason(row)) continue;
    const timestamp = Number.isFinite(Date.parse(String(row.timestamp))) ? String(row.timestamp) : observedTs;
    const base = { source: "transcript-claude" as const, confidence: "confirmed" as const, source_ts: timestamp, observed_ts: observedTs, cursor: null };
    if (row.type === "user" || row.type === "assistant") firstMessageTs ??= timestamp;
    if (!located && typeof row.cwd === "string" && row.cwd) {
      location = locate(row.cwd);
      append({ ...base, kind: "conversation.updated", subject: `conversation:${id}`, source_event_id: locationId, payload: { ...location } });
      located = true;
    }
    const evidence = turns ? classifyClaudeRecord(row) : undefined;
    if (!evidence) continue;
    const time = Date.parse(timestamp);
    // 行より前に始まった実行のうち、最も新しいものに結ぶ。
    let target = [...hooks, ...(own ? [own] : [])].filter((run) => run.started <= time)
      .sort((left, right) => right.started - left.started)[0] ?? own;
    if (!target) {
      const generation = Number.isSafeInteger(time) && time > 0 ? time : 1;
      own = { subject: `run:${id}:${generation}`, generation, started: generation };
      append({ ...base, kind: "run.created", subject: own.subject as `run:${string}`, source_event_id: `run:${id}`,
        payload: { conversation_id: id, generation, state: "unknown", reason: "missing_state_evidence", started_ts: timestamp,
          ...(location ? { cwd: location.cwd, ...(location.repository_id ? { repository_id: location.repository_id } : {}) } : {}) } });
      target = own;
    }
    if (states.get(target.subject) === evidence.state) continue;
    states.set(target.subject, evidence.state);
    append({ ...base, kind: "run.state_changed", subject: target.subject as `run:${string}`,
      source_event_id: `turn:v${TURN_RULE_VERSION}:${id}:${String(row.uuid ?? line.cursor.offset)}`,
      payload: { conversation_id: id, generation: target.generation, state: evidence.state,
        last_evidence: { kind: evidence.kind, turn_id: evidence.turn_id ?? null }, last_evidence_ts: timestamp,
        ...(evidence.model ? { model: evidence.model } : {}) } });
  }
  // 発言があるのに場所の記録がない会話は、旧い形式として場所なしで読み終えたことを残す。
  if (!located && firstMessageTs) {
    append({ source: "transcript-claude", confidence: "confirmed", source_ts: firstMessageTs, observed_ts: observedTs, cursor: null,
      kind: "conversation.updated", subject: `conversation:${id}`, source_event_id: locationId, payload: {} });
  }
  return result;
}
