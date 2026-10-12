import { createHash } from "node:crypto";
import { join } from "node:path";
import { createNativeId, compareFacts } from "../../../../core/src/ledger/index.ts";
import type { AppendResult, Ledger } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../files.ts";
import type { FileCursor } from "../files.ts";

const titleCursors = new WeakMap<Ledger, Map<string, FileCursor>>();

function readTitleCursors(ledger: Ledger): Map<string, FileCursor> {
  let cursors = titleCursors.get(ledger);
  if (!cursors) { cursors = new Map(); titleCursors.set(ledger, cursors); }
  return cursors;
}

/** 題名索引は rollout の更新がなくても読む。未観測のスレッドは会話を作らない。 */
export function observeCodexTitles(ledger: Ledger, home: string, observedTs: string, knownSubjects?: ReadonlySet<string>,
  cursors = readTitleCursors(ledger)): AppendResult[] {
  const path = join(home, "session_index.jsonl");
  let file;
  try { file = readAppendOnlyFile(path, cursors.get(path)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  if (!file.lines.length) { cursors.set(path, file.cursor); return []; }
  const titles = new Map<string, { title: string; timestamp: string; offset: number }>();
  for (const line of file.lines) {
    let row;
    try { row = JSON.parse(line.text); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (!row || typeof row.id !== "string" || !row.id || typeof row.thread_name !== "string"
      || !row.thread_name.trim() || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) continue;
    const previous = titles.get(row.id);
    if (!previous || Date.parse(row.updated_at) >= Date.parse(previous.timestamp)) {
      titles.set(row.id, { title: row.thread_name.trim(), timestamp: row.updated_at, offset: line.cursor.offset });
    }
  }
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const conversations = knownSubjects ?? new Set(facts.filter(fact => fact.kind === "conversation.created" || fact.kind === "conversation.corrected")
    .map(fact => fact.subject));
  const current = new Map<string, { title: unknown; timestamp: string }>();
  for (const fact of facts.filter(fact => fact.kind.startsWith("conversation.")).sort(compareFacts)) {
    const payload = fact.payload as { ai_title?: unknown } | null;
    if (payload?.ai_title !== undefined) current.set(fact.subject, { title: payload.ai_title, timestamp: fact.source_ts });
  }
  const results: AppendResult[] = [];
  for (const [nativeId, { title, timestamp, offset }] of titles) {
    const subject = `conversation:${createNativeId("codex", nativeId)}` as const;
    const previous = current.get(subject);
    if (!conversations.has(subject) || previous?.title === title
      || previous && Date.parse(previous.timestamp) > Date.parse(timestamp)) continue;
    results.push(ledger.append({ source: "rollout-codex", source_event_id: `session-index:${nativeId}:${timestamp}:${String(offset).padStart(16, "0")}:${createHash("sha256").update(title).digest("hex")}`,
      source_ts: timestamp, observed_ts: observedTs, confidence: "confirmed",
      kind: "conversation.updated", subject, payload: { ai_title: title } }));
  }
  if (!results.some(result => result.status === "conflict")) cursors.set(path, file.cursor);
  return results;
}
