import { useEffect, useState } from 'react';
import type { Language } from '../lib/i18n.ts';

const MINUTE_MS = 60_000;
const TICK_MS = 1_000;
export function formatDuration(start: unknown, end: unknown, now: number): string {
  const beginning = typeof start === 'string' ? Date.parse(start) : NaN;
  const finish = typeof end === 'string' ? Date.parse(end) : now;
  if (!Number.isFinite(beginning) || !Number.isFinite(finish)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((finish - beginning) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(timer); }, []);
  return now;
}
export function RelativeTime({ value, language = 'en', now }: { value?: string; language?: Language; now: number }) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return <span>{language === 'ja' ? '不明' : 'Unknown'}</span>;
  const minutes = Math.round((timestamp - now) / MINUTE_MS);
  const unit = Math.abs(minutes) < 60 ? 'minute' : Math.abs(minutes) < 1440 ? 'hour' : 'day';
  const amount = unit === 'minute' ? minutes : Math.round(minutes / (unit === 'hour' ? 60 : 1440));
  return <time dateTime={value} title={value}>{new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(amount, unit)}</time>;
}
