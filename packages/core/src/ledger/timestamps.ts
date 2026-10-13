const TIMESTAMP_PATTERN = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i;

// 時差省略は SQLite と同じ UTC。Date.parse が繰り上げる日付は先に拒否する。
function parseTimestamp(value: string): string | undefined {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  const leapYear = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  const offset = zone.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  // 小数秒の余りは切り捨て、常に UTC・ミリ秒 3 桁へ揃える。
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.slice(0, 3).padEnd(3, '0')}${offset}`);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export function normalizeTimestamp(value: string): string {
  const normalized = parseTimestamp(value);
  if (normalized === undefined) throw new TypeError('時刻は有効な日時で指定してください');
  return normalized;
}

// 追記済みの値は捨てずに残し、不正な 1 件で投影や補完を止めない。
export function normalizeStoredTimestamp(value: string): string {
  return parseTimestamp(value) ?? value;
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
    if (typeof timestamp === 'string') Object.assign(result, { [field]: normalizeStoredTimestamp(timestamp) });
  }
  return result;
}
