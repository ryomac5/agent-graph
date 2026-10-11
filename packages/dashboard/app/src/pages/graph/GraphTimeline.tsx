import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { stateTone, toDisplayState } from '../../components/StateBadge.tsx';
import { graphText } from '../../lib/i18n.ts';
import { GraphOutline, rowEnd, type OutlineProps } from './GraphOutline.tsx';
import { APPROVAL_ROW_HEIGHT, type TimeSegment } from './rows.ts';
export const RANGES = ['1h', '6h', '24h', 'All'] as const;
export type TimeRange = typeof RANGES[number];
const GAP_MS = 30 * 60 * 1000;
const GAP_WIDTH = 16;
/** 仕事のない時間だけを詰め、棒と目盛りを同じ尺度に写す。 */
export function createTimeScale(segments: TimeSegment[], now: number, range: TimeRange, width: number) {
  const start = range === 'All' ? Math.min(now - 60_000, ...segments.map(item => item.start)) : now - Number.parseInt(range) * 60 * 60 * 1000;
  const intervals = segments.filter(item => item.end >= start && item.start <= now).map(item => ({ start: Math.max(start, item.start), end: Math.min(now, item.end) })).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  const gaps: { start: number; end: number }[] = [];
  let cursor = start;
  for (const interval of merged) { if (interval.start - cursor > GAP_MS) gaps.push({ start: cursor, end: interval.start }); cursor = interval.end; }
  if (now - cursor > GAP_MS && merged.length) gaps.push({ start: cursor, end: now });
  const duration = Math.max(1, now - start - gaps.reduce((sum, gap) => sum + gap.end - gap.start, 0));
  const pixels = Math.max(1, width - gaps.length * GAP_WIDTH);
  function position(time: number) {
    const clipped = Math.min(now, Math.max(start, time));
    let removed = 0; let added = 0;
    for (const gap of gaps) {
      if (clipped >= gap.end) { removed += gap.end - gap.start; added += GAP_WIDTH; }
      else if (clipped > gap.start) { removed += clipped - gap.start; added += GAP_WIDTH * (clipped - gap.start) / (gap.end - gap.start); }
    }
    return ((clipped - start - removed) / duration * pixels + added) / width * 100;
  }
  const ticks = Array.from({ length: 5 }, (_, index) => start + (now - start) * index / 4).filter(time => !gaps.some(gap => time > gap.start && time < gap.end));
  return { start, position, gaps, ticks };
}
export function GraphTimeline({ range, onRange, ...props }: OutlineProps & { range: TimeRange; onRange: (range: TimeRange) => void }) {
  const measure = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = measure.current!;
    const update = () => { if (element.clientWidth) setWidth(element.clientWidth); };
    update(); const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element); window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const t = graphText[props.language];
  const scale = createTimeScale(props.model.all.filter(row => row.role !== 'main' || props.model.all.length === 1).flatMap(row => row.segments), props.now, range, width);
  const offsets = new Map<string, number>(); let offset = 0;
  for (const row of props.model.rows) { offsets.set(row.id, offset); offset += row.height; }
  return <>
    <div className="graph-range" role="group" aria-label={t.range}>{RANGES.map(item => <button key={item} aria-pressed={range === item} className={range === item ? 'is-active' : ''} onClick={() => onRange(item)}>{item}</button>)}</div>
    <div className="graph-scroll">
      <div className="graph-time-header"><div>{t.request}<span>{t.who}</span></div><div ref={measure} className="graph-time-axis">
        {scale.ticks.map(time => <time key={time} style={{ left: `${scale.position(time)}%` }}>{new Date(time).toLocaleTimeString(props.language, { hour: '2-digit', minute: '2-digit' })}</time>)}
        {/* 何も動いていない長い時間は詰めて描く。軸の上にだけ、詰めた所の印を出す。 */}
        {scale.gaps.map(gap => <span key={gap.start} className="graph-time-gap" style={{ left: `${scale.position((gap.start + gap.end) / 2)}%` }}>⋯</span>)}<span className="graph-now-label">{t.now}</span>
      </div><div/></div>
      <GraphOutline {...props} timeline={row => <>
        <div className="graph-time-cell" style={{ '--graph-node-center': `${(row.height - (row.node?.approvals?.length ?? 0) * APPROVAL_ROW_HEIGHT) / 2}px` } as CSSProperties}><i className="graph-now"/>
          {row.segments.filter(segment => segment.end >= scale.start).map((segment, index) => <span key={index} className={`graph-time-bar tone-${stateTone(toDisplayState(segment.state))}`} title={`${new Date(segment.start).toLocaleString(props.language)} – ${new Date(segment.end).toLocaleString(props.language)}`}
            style={{ left: `${scale.position(segment.start)}%`, width: `${Math.max(0.1, scale.position(segment.end) - scale.position(segment.start))}%` }} data-segment={index}/>)}
          {row.parent && row.segments[0] && offsets.has(row.parent) && row.segments[0].start >= scale.start && <i className={`graph-time-connector${row.runningPath ? ' is-running' : ''}`} style={{ left: `${scale.position(row.segments[0].start)}%`, top: `calc(var(--graph-node-center) - ${(offsets.get(row.id)! - offsets.get(row.parent)!)}px)`, height: offsets.get(row.id)! - offsets.get(row.parent)! }}/>}
        </div><div className={`graph-time-end state-${toDisplayState(row.node?.state ?? 'idle')}`}>{(row.node?.attempts.length ?? 0) > 1 && <span>×{row.node!.attempts.length} </span>}{row.role === 'main' && row.runningBelow ? '' : rowEnd(row, props.language, props.now)}</div>
      </>}/>
    </div>
  </>;
}
