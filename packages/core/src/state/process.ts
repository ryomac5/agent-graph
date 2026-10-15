/** Claude の登録は UTC、旧 ps の lstart は OS のローカル時刻。保存・比較は epoch milliseconds に揃える。 */
export function normalizeProcessStart(value: string, zone: 'UTC' | 'local'): string {
  if (!/^[A-Za-z]{3} [A-Za-z]{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4}$/.test(value)) return value;
  const epoch = Date.parse(zone === 'UTC' ? `${value} GMT` : value);
  return Number.isFinite(epoch) ? String(epoch) : value;
}
