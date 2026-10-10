import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { ResizeDivider } from './ResizeDivider.tsx';
const MIN_RATIO = 0.1;
export function ResizableStack({ storageKey, defaults, labels, children, collapsedFirst = false }: {
  storageKey: string; defaults: number[]; labels: string[]; children: ReactNode[]; collapsedFirst?: boolean;
}) {
  const [ratios, setRatios] = useState<number[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (Array.isArray(saved) && saved.length === defaults.length && saved.every(value => typeof value === 'number' && Number.isFinite(value) && value >= MIN_RATIO)
        && Math.abs(saved.reduce((sum, value) => sum + value, 0) - 1) < 0.001) return saved;
    } catch { /* 壊れた保存値は既定へ戻す。 */ }
    return defaults;
  });
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(ratios)); }, [storageKey, ratios]);
  function resize(index: number, delta: number) {
    const pair = ratios[index] + ratios[index + 1];
    const first = Math.max(MIN_RATIO, Math.min(pair - MIN_RATIO, ratios[index] + delta));
    setRatios(ratios.map((value, position) => position === index ? first : position === index + 1 ? pair - first : value));
  }
  return <div className="resizable-stack">{children.map((child, index) => <Fragment key={index}>
    {!(collapsedFirst && index === 0) && <div className="resizable-section" style={{ flexGrow: ratios[index] }}>{child}</div>}
    {index < children.length - 1 && !(collapsedFirst && index === 0) && <ResizeDivider label={labels[index]} orientation="horizontal" value={Math.round(ratios[index] * 100)} min={10} max={Math.round((ratios[index] + ratios[index + 1] - MIN_RATIO) * 100)}
      onChange={value => resize(index, value / 100 - ratios[index])} onDrag={(delta, bounds) => { if (bounds.height) resize(index, delta / (bounds.height - (children.length - 1) * 6)); }}
      onReset={() => setRatios(defaults)}/>}
  </Fragment>)}</div>;
}
