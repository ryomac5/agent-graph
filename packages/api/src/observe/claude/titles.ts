import { projectConversations } from "../../../../core/src/ledger/index.ts";
import type { AppendResult, Ledger } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile, type FileLine } from "../files.ts";
import { claudeConversationId } from "./context.ts";
import { parseRow } from "./index.ts";

export function claudeTitleBackfillEventId(conversationId: string): string {
  return `conversation:${conversationId}:ai-title-backfill`;
}

/** 題名がない会話の既読範囲を一度だけ読み、題名がなくても読み終えた印を残す。 */
export function observeClaudeTitles(ledger: Ledger, path: string,
  options: { lines?: FileLine[]; fromStart?: boolean; observedTs?: string } = {}): AppendResult[] {
  const id = claudeConversationId(path);
  const existing = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const conversation = projectConversations(existing, new Map()).conversations.find(row => row.id === id);
  const eventId = claudeTitleBackfillEventId(id);
  if (!conversation || conversation.ai_title || existing.some(fact => fact.source === "transcript-claude" && fact.source_event_id === eventId)) return [];
  const lines = options.fromStart && options.lines ? options.lines : readAppendOnlyFile(path).lines;
  let title: string | undefined;
  for (const line of lines) {
    const row = parseRow(line.text);
    if (row?.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) title = row.aiTitle.trim();
  }
  const observedTs = options.observedTs ?? new Date().toISOString();
  return [ledger.append({ source: "transcript-claude", source_event_id: eventId, source_ts: title ? observedTs : conversation.created_ts ?? observedTs,
    observed_ts: observedTs, confidence: "confirmed", cursor: null, kind: "conversation.updated",
    subject: `conversation:${id}`, payload: title ? { ai_title: title } : {} })];
}
