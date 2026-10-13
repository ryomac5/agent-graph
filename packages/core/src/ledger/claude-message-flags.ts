export const CLAUDE_INTERNAL_MESSAGE_FLAGS = ["isCompactSummary", "isMeta", "isVisibleInTranscriptOnly"] as const;
export type ClaudeMessageFlags = { [K in typeof CLAUDE_INTERNAL_MESSAGE_FLAGS[number]]?: boolean };

/** 状態判定に使わない内部行を識別する。表示可否は正規化後の role で別に判定する。 */
export function isClaudeInternalMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return CLAUDE_INTERNAL_MESSAGE_FLAGS.some(flag => (value as Record<string, unknown>)[flag] === true);
}

/** isMeta の報告・通知・中継は残し、正規化後も user のその他の内部行だけを隠す。 */
export function isClaudeHiddenMessage(value: unknown, role: unknown, relayedInstruction = false): boolean {
  if (!value || typeof value !== "object") return false;
  const flags = value as ClaudeMessageFlags;
  return flags.isCompactSummary === true || flags.isVisibleInTranscriptOnly === true
    || flags.isMeta === true && role === "user" && !relayedInstruction;
}

export function readClaudeMessageFlags(row: Record<string, unknown>): ClaudeMessageFlags {
  return Object.fromEntries(CLAUDE_INTERNAL_MESSAGE_FLAGS.filter(flag => row[flag] === true).map(flag => [flag, true]));
}
