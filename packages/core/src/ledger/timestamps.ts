// 台帳の索引列と投影の時刻は UTC・ミリ秒 3 桁に揃える。小数秒の余りは切り捨てる。
export function normalizeTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('時刻は有効な日時で指定してください');
  return new Date(time).toISOString();
}

export const TIMESTAMP_FIELDS = [
  'source_ts', 'observed_ts', 'created_ts', 'started_ts', 'ended_ts',
  'turn_started_ts', 'last_evidence_ts', 'requested_ts', 'last_detected_ts',
  'last_activity_ts', 'last_message_ts', 'sent_ts', 'closed_ts', 'failed_ts',
] as const;

// 本文や証拠の中の任意の値には触れず、投影の定義済みの欄だけを変換する。
export function normalizeTimestampFields<T extends object>(value: T): T {
  const result = { ...value } as T & Record<string, unknown>;
  for (const field of TIMESTAMP_FIELDS) {
    const timestamp = result[field];
    if (typeof timestamp === 'string') Object.assign(result, { [field]: normalizeTimestamp(timestamp) });
  }
  return result;
}
