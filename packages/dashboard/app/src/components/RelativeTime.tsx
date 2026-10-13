import { useContext, useEffect, useState } from 'react';
import { ViewVisible } from '../lib/visibility.tsx';
import type { Language } from '../lib/i18n.ts';

import { formatWhen } from '../lib/format.ts';
const TICK_MS = 1_000;
export function formatDuration(start: unknown, end: unknown, now: number): string {
  const beginning = typeof start === 'string' ? Date.parse(start) : NaN;
  const finish = typeof end === 'string' ? Date.parse(end) : now;
  if (!Number.isFinite(beginning) || !Number.isFinite(finish)) return 'Unknown';
  const seconds = Math.max(0, Math.floor((finish - beginning) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function useNow(enabled = true) {
  const visible = useContext(ViewVisible);
  enabled = enabled && visible;
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (!enabled) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), TICK_MS); return () => clearInterval(timer); }, [enabled]);
  return now;
}
/** 日付だけに依存する表示は、現地時刻の日付が変わるときに更新する。 */
export function useToday() {
  const visible = useContext(ViewVisible);
  const [day, setDay] = useState(() => new Date(Date.now()).setHours(0, 0, 0, 0));
  useEffect(() => {
    if (!visible) return;
    const update = () => setDay(new Date(Date.now()).setHours(0, 0, 0, 0));
    const current = new Date(Date.now()).setHours(0, 0, 0, 0);
    if (day !== current) setDay(current);
    const midnight = new Date(Date.now()); midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(update, midnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [day, visible]);
  return day;
}
export function LiveRelativeTime(props: { value?: string; language?: Language }) {
  return <RelativeTime {...props} now={useToday()}/>;
}
export function RelativeTime({ value, language = 'en', now }: { value?: string; language?: Language; now: number }) {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return <span>{language === 'ja' ? '不明' : 'Unknown'}</span>;
  return <time dateTime={value} title={value}>{formatWhen(value, language, now)}</time>;
}
