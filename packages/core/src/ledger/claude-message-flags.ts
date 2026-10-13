export const CLAUDE_INTERNAL_MESSAGE_FLAGS = ["isCompactSummary", "isMeta", "isVisibleInTranscriptOnly"] as const;
export type ClaudeMessageFlags = { [K in typeof CLAUDE_INTERNAL_MESSAGE_FLAGS[number]]?: boolean };

/** 本文や時刻ではなく、Claude が記録した非発言の旗だけを根拠にする。 */
export function isClaudeInternalMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return CLAUDE_INTERNAL_MESSAGE_FLAGS.some(flag => (value as Record<string, unknown>)[flag] === true);
}

export function readClaudeMessageFlags(row: Record<string, unknown>): ClaudeMessageFlags {
  return Object.fromEntries(CLAUDE_INTERNAL_MESSAGE_FLAGS.filter(flag => row[flag] === true).map(flag => [flag, true]));
}
