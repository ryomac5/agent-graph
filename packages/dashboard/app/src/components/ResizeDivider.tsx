import { useEffect, useRef } from 'react';
import './resize.css';

export function ResizeDivider({ label, orientation, value, min, max, step = 5, reverse = false, className = '', onChange, onDrag, onReset }: {
  label: string; orientation: 'vertical' | 'horizontal'; value: number; min: number; max: number; step?: number; reverse?: boolean; className?: string;
  onChange: (value: number) => void; onDrag: (delta: number, bounds: DOMRect) => void; onReset: () => void;
}) {
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={orientation} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    className={`resize-divider ${className}`} onDoubleClick={onReset}
    onKeyDown={event => {
      const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      if (keys.includes(event.key)) { event.preventDefault(); onChange(value + (event.key === keys[0] ? -step : step) * (reverse ? -1 : 1)); }
      else if (event.key === 'Home') { event.preventDefault(); onReset(); }
    }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); stop.current();
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
      const start = orientation === 'vertical' ? event.clientX : event.clientY;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const move = (event: PointerEvent) => onDrag((orientation === 'vertical' ? event.clientX : event.clientY) - start, bounds);
      const finish = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); };
      stop.current = finish;
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    }}/>;
}
