// 台帳と runner が状態に付ける理由の符号を、人が読む英語に置き換える。画面の全ての状態の表示がこの表を使う。
const REASONS: Record<string, string> = {
  missing_state_evidence: 'No state recorded yet',
  unconfirmed_state_evidence: 'State not confirmed',
  unconfirmed_end_evidence: 'No end recorded',
  missing_failure_cause: 'Failure cause not recorded',
  missing_turn_evidence: 'No turn record',
  archive_resume: 'Resumed from archive',
  no_updates: 'No recent updates',
  process_list_failed: 'Process check failed',
  restart: 'Restarted',
  update: 'Runner updated',
  host_stream_closed_without_exit: 'Host closed without exit code',
  host_or_request_unavailable: 'Host or request unavailable',
  claude_child_lost_on_restart: 'Child process lost on restart',
  query_closed: 'Session closed',
  interrupted: 'Interrupted',
};
const LEGACY_ENDS: Record<string, string> = {
  process_exit: 'Ended by process exit (legacy)',
  idle: 'Ended while idle (legacy)',
  explicit: 'Ended explicitly (legacy)',
  'missing evidence': 'Ended',
};

/** 理由の符号を読める文にする。表にない機械の語は語の区切りを空白にして、先頭を大文字にする。 */
export function reasonText(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  const value = reason.trim();
  if (!value) return '';
  if (REASONS[value]) return REASONS[value];
  const legacy = /^legacy ended inference:\s*(.+)$/.exec(value);
  if (legacy) return LEGACY_ENDS[legacy[1]] ?? `Ended by ${legacy[1].replace(/[_-]+/g, ' ')} (legacy)`;
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(value)) {
    const words = value.replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return value;
}
