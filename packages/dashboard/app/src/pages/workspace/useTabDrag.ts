import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { PaneEdge } from '../../lib/panes.ts';

export type TabDrop = { pane: string; edge?: PaneEdge; before?: string; tablist?: boolean };
const DRAG_THRESHOLD = 3;
const EDGE_FRACTION = 0.25;

export function findTabDrop(root: HTMLElement, x: number, y: number, source: string): TabDrop | undefined {
  const hit = document.elementFromPoint(x, y);
  const pane = hit?.closest<HTMLElement>('[data-pane-id]');
  if (!pane || !root.contains(pane)) return;
  const paneId = pane.dataset.paneId!;
  const header = hit?.closest('.workbench-tabs');
  if (header) {
    const tabs = [...pane.querySelectorAll<HTMLElement>('[data-tab-id]')].filter(tab => tab.dataset.tabId !== source);
    const before = tabs.find(tab => { const rect = tab.getBoundingClientRect(); return x < rect.left + rect.width / 2; })?.dataset.tabId;
    return { pane: paneId, before, tablist: true };
  }
  const bounds = pane.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const distances: [PaneEdge, number][] = [['left', (x - bounds.left) / bounds.width], ['right', (bounds.right - x) / bounds.width], ['top', (y - bounds.top) / bounds.height], ['bottom', (bounds.bottom - y) / bounds.height]];
  distances.sort((a, b) => a[1] - b[1]);
  return { pane: paneId, ...(distances[0][1] < EDGE_FRACTION ? { edge: distances[0][0] } : {}) };
}

export function useTabDrag(root: RefObject<HTMLDivElement | null>, drop: (tab: string, target: TabDrop) => void) {
  const [preview, setPreview] = useState<TabDrop>();
  const [dragging, setDragging] = useState<string>();
  const stop = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const apply = useRef(drop);
  apply.current = drop;
  useEffect(() => () => stop.current(), []);
  function begin(event: ReactPointerEvent, tab: string) {
    if (event.button !== 0 || (event.target as Element).closest('input, .icon-button')) return;
    stop.current();
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    const capture = (event.target as Element).closest<HTMLElement>('button[role="tab"]') ?? event.currentTarget;
    capture.setPointerCapture?.(pointerId);
    let moved = false;
    function move(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      event.preventDefault();
      setDragging(tab);
      setPreview(root.current ? findTabDrop(root.current, event.clientX, event.clientY, tab) : undefined);
    }
    function finish(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      const target = moved && event.type === 'pointerup' && root.current ? findTabDrop(root.current, event.clientX, event.clientY, tab) : undefined;
      cleanup();
      if (moved) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (event.type === 'pointerup' && target) apply.current(tab, target);
      }
    }
    function cancel(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (moved) suppressClick.current = true;
      cleanup();
    }
    function cleanup() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancel);
      window.removeEventListener('blur', cleanup);
      capture.removeEventListener('lostpointercapture', cleanup);
      if (capture.hasPointerCapture?.(pointerId)) capture.releasePointerCapture(pointerId);
      setPreview(undefined); setDragging(undefined);
    }
    stop.current = cleanup;
    suppressClick.current = false;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancel);
    window.addEventListener('blur', cleanup);
    capture.addEventListener('lostpointercapture', cleanup);
  }
  return { preview, dragging, begin, suppressClick };
}
