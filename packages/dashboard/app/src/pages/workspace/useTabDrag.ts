import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { PaneEdge } from '../../lib/panes.ts';

export type TabDrop = { pane: string; edge?: PaneEdge; before?: string; tablist?: boolean; line?: number };
const DRAG_THRESHOLD = 3;
const EDGE_FRACTION = 0.25;
const SCROLL_EDGE = 32;
const SCROLL_SPEED = 12;

export function findTabDrop(root: HTMLElement, x: number, y: number, source: string): TabDrop | undefined {
  const hit = document.elementFromPoint(x, y);
  const pane = hit?.closest<HTMLElement>('[data-pane-id]');
  if (!pane || !root.contains(pane)) return;
  const paneId = pane.dataset.paneId!;
  const header = hit?.closest('.workbench-tabs');
  if (header) {
    const list = pane.querySelector<HTMLElement>('.workbench-tablist')!;
    const bounds = list.getBoundingClientRect();
    const tabs = [...list.querySelectorAll<HTMLElement>('[data-tab-id]')].filter(tab => tab.dataset.tabId !== source);
    // 見えている最後のタブの後ろを、隠れたタブの手前として扱う。
    const visible = tabs.filter(tab => { const rect = tab.getBoundingClientRect(); return !bounds.width || rect.right > bounds.left && rect.left < bounds.right; });
    const before = visible.find(tab => { const rect = tab.getBoundingClientRect(); return x < rect.left + rect.width / 2; });
    const last = visible.at(-1);
    const next = last ? tabs[tabs.indexOf(last) + 1] : tabs[0];
    const line = before?.getBoundingClientRect().left ?? last?.getBoundingClientRect().right ?? bounds.left;
    return { pane: paneId, before: (before ?? next)?.dataset.tabId, tablist: true, line: Math.max(bounds.left, Math.min(bounds.right - 2, line)) - pane.getBoundingClientRect().left };
  }
  const bounds = pane.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const distances: [PaneEdge, number][] = [['left', (x - bounds.left) / bounds.width], ['right', (bounds.right - x) / bounds.width], ['top', (y - bounds.top) / bounds.height], ['bottom', (bounds.bottom - y) / bounds.height]];
  distances.sort((a, b) => a[1] - b[1]);
  const edge = distances[0][1] < EDGE_FRACTION ? distances[0][0] : undefined;
  if (edge && pane.querySelector(`[data-tab-id="${CSS.escape(source)}"]`) && pane.querySelectorAll('[data-tab-id]').length === 1) return;
  return { pane: paneId, ...(edge ? { edge } : {}) };
}

export function useTabDrag(root: RefObject<HTMLDivElement | null>, drop: (tab: string, target: TabDrop) => void) {
  const [preview, setPreview] = useState<TabDrop>();
  const [dragging, setDragging] = useState<string>();
  const [point, setPoint] = useState<{ x: number; y: number }>();
  const stop = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const active = useRef(false);
  const apply = useRef(drop);
  apply.current = drop;
  useEffect(() => () => stop.current(), []);
  function begin(event: ReactPointerEvent, tab: string) {
    if (event.button !== 0 || active.current || (event.target as Element).closest('input, .icon-button')) return;
    stop.current();
    const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
    const capture = (event.target as Element).closest<HTMLElement>('button[role="tab"]') ?? event.currentTarget;
    capture.setPointerCapture?.(pointerId);
    let moved = false, frame = 0, x = startX, y = startY;
    function update() {
      const target = root.current ? findTabDrop(root.current, x, y, tab) : undefined;
      setPreview(target); setPoint({ x, y });
      document.documentElement.dataset.pointerDrag = target ? 'grabbing' : 'not-allowed';
    }
    function scroll() {
      if (!moved) return;
      const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.workbench-tablist');
      if (hit && root.current?.contains(hit)) {
        const bounds = hit.getBoundingClientRect();
        const delta = x < bounds.left + SCROLL_EDGE ? -SCROLL_SPEED : x > bounds.right - SCROLL_EDGE ? SCROLL_SPEED : 0;
        if (delta) { hit.scrollLeft += delta; update(); }
      }
      frame = requestAnimationFrame(scroll);
    }
    function move(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      if (!moved && Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
      event.preventDefault(); x = event.clientX; y = event.clientY;
      if (!moved) { moved = true; active.current = true; setDragging(tab); frame = requestAnimationFrame(scroll); }
      update();
    }
    function finish(event: PointerEvent) {
      if (event.pointerId !== pointerId) return;
      const target = moved && event.type === 'pointerup' && root.current ? findTabDrop(root.current, event.clientX, event.clientY, tab) : undefined;
      cleanup();
      if (moved) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (target) apply.current(tab, target);
      }
    }
    function cancel(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (moved) suppressClick.current = true;
      cleanup();
    }
    function cleanup() {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('blur', cleanup);
      capture.removeEventListener('lostpointercapture', cleanup);
      if (capture.hasPointerCapture?.(pointerId)) capture.releasePointerCapture(pointerId);
      active.current = false;
      delete document.documentElement.dataset.pointerDrag;
      setPreview(undefined); setDragging(undefined); setPoint(undefined);
    }
    stop.current = cleanup; suppressClick.current = false;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancel, true);
    window.addEventListener('blur', cleanup);
    capture.addEventListener('lostpointercapture', cleanup);
  }
  return { preview, dragging, point, active, begin, suppressClick };
}
