import { useLayoutEffect, useRef } from 'react';

export function useAutosizeTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    function resize() {
      const style = getComputedStyle(element!);
      const minimum = parseFloat(style.minHeight) || 0;
      const maximum = parseFloat(style.maxHeight) || Infinity;
      element!.style.height = 'auto';
      element!.style.height = `${Math.max(minimum, Math.min(element!.scrollHeight, maximum))}px`;
    }
    resize();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer?.disconnect(); window.removeEventListener('resize', resize); };
  }, [value]);
  return ref;
}
