import { useLayoutEffect, useRef } from 'react';

const layers: (() => void)[] = [];

export function useEscapeLayer(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = () => latest.current();
    layers.push(dismiss);
    return () => { layers.splice(layers.indexOf(dismiss), 1); };
  }, [open]);
}

export function dismissEscapeLayer(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape') return false;
  const close = layers.at(-1);
  if (!close) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
  return true;
}
