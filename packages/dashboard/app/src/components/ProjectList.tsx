import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { dictionaries, type Language } from '../lib/i18n.ts';
import { loadProjectList, moveProject, PROJECT_LIST_KEY, reconcileProjectList } from '../lib/project-list.ts';

const DRAG_THRESHOLD = 3;
const CLICK_SUPPRESSION_MS = 250;
export interface SidebarProject { id: string; name: string; full: string; detail: string }
export function ProjectList({ projects, language, renderProject }: {
  projects: SidebarProject[]; language: Language;
  renderProject: (row: SidebarProject, attributes: HTMLAttributes<HTMLDivElement>, actions: ReactNode) => ReactNode;
}) {
  const t = dictionaries[language];
  const [saved, setSaved] = useState(loadProjectList);
  const preferences = reconcileProjectList(saved, projects.map(row => row.id));
  const serialized = JSON.stringify(preferences);
  useEffect(() => {
    localStorage.setItem(PROJECT_LIST_KEY, serialized);
    setSaved(value => JSON.stringify(value) === serialized ? value : JSON.parse(serialized));
  }, [serialized]);
  const ordered = preferences.order.flatMap(id => projects.filter(row => row.id === id));
  const visible = ordered.filter(row => !preferences.hidden.includes(row.id));
  const hidden = ordered.filter(row => preferences.hidden.includes(row.id));
  const ids = visible.map(row => row.id);
  const [menu, setMenu] = useState<string>();
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; after: boolean }>();
  const list = useRef<HTMLElement>(null);
  const focusRow = (id: string) => [...(list.current?.querySelectorAll<HTMLElement>('[data-project-id]') ?? [])].find(row => row.dataset.projectId === id)?.querySelector<HTMLElement>('.sidebar-project-row')?.focus();
  useEffect(() => {
    if (!menu) return;
    list.current?.querySelector<HTMLButtonElement>('.project-actions-menu button:not(:disabled)')?.focus();
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.project-actions-menu, .project-actions')) setMenu(undefined); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);
  const move = (id: string, position: number) => { setSaved(moveProject(preferences, ids, id, position)); setMenu(undefined); focusRow(id); };
  const stop = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function resetClick() { clearTimeout(clickTimer.current); suppressClick.current = false; }
  function suppressNextClick() {
    resetClick(); suppressClick.current = true;
    clickTimer.current = setTimeout(resetClick, CLICK_SUPPRESSION_MS);
  }
  useEffect(() => {
    window.addEventListener('pointerdown', resetClick, true);
    return () => { window.removeEventListener('pointerdown', resetClick, true); resetClick(); };
  }, []);
  const pointerDragging = useRef(false);
  useEffect(() => () => stop.current(), []);
  function findDrop(x: number, y: number) {
    const block = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-project-id]');
    if (!block || !list.current?.contains(block)) return;
    const bounds = block.getBoundingClientRect();
    return { id: block.dataset.projectId!, after: y >= bounds.top + bounds.height / 2 };
  }
  function begin(event: ReactPointerEvent, id: string) {
    if (event.button !== 0 || (event.target as Element).closest('button, .project-actions-menu')) return;
    stop.current();
    const capture = event.currentTarget, pointer = event.pointerId, x = event.clientX, y = event.clientY;
    let moved = false;
    function update(event: PointerEvent) {
      if (event.pointerId !== pointer || !moved && Math.hypot(event.clientX - x, event.clientY - y) < DRAG_THRESHOLD) return;
      if (!moved) capture.setPointerCapture?.(pointer);
      moved = true; pointerDragging.current = true; event.preventDefault(); setDragging(id); setMenu(undefined);
      const target = findDrop(event.clientX, event.clientY);
      setDrop(target); document.documentElement.dataset.pointerDrag = target ? 'grabbing' : 'not-allowed';
    }
    function finish(event: PointerEvent) {
      if (event.pointerId !== pointer) return;
      const target = moved && event.type === 'pointerup' ? findDrop(event.clientX, event.clientY) : undefined;
      cleanup();
      if (moved) {
        suppressNextClick();
        if (target) { const index = ids.indexOf(target.id); move(id, index + Number(target.after) - Number(ids.indexOf(id) < index + Number(target.after))); }
      }
    }
    function cancel(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (moved) suppressNextClick(); cleanup(); } }
    function cleanup() {
      window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      window.removeEventListener('keydown', cancel, true); window.removeEventListener('blur', cleanup); capture.removeEventListener('lostpointercapture', cleanup);
      if (capture.hasPointerCapture?.(pointer)) capture.releasePointerCapture(pointer);
      pointerDragging.current = false; delete document.documentElement.dataset.pointerDrag; clearDrag();
    }
    stop.current = cleanup; suppressClick.current = false;
    window.addEventListener('pointermove', update, { passive: false }); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
    window.addEventListener('keydown', cancel, true); window.addEventListener('blur', cleanup); capture.addEventListener('lostpointercapture', cleanup);
  }
  const clearDrag = () => { setDragging(undefined); setDrop(undefined); };
  return <nav ref={list} aria-label={t.projects} className="nav-group project-list">{visible.map((row, index) => <div key={row.id} data-project-id={row.id}
    onClickCapture={event => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDrop(undefined); }}
    className={`sidebar-project${dragging === row.id ? ' project-dragging' : ''}${drop?.id === row.id ? drop.after ? ' project-drop-after' : ' project-drop-before' : ''}`}>
    {drop?.id === row.id && <span className="project-insertion" aria-hidden="true"/>}
    {renderProject(row, {
      tabIndex: 0, draggable: false, onPointerDown: event => begin(event, row.id), 'aria-label': row.name, 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
      onKeyDown: event => {
        if (event.altKey && !event.ctrlKey && !event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); move(row.id, Math.max(0, Math.min(ids.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1))));
        } else if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); setMenu(undefined); focusRow(row.id); }
        else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setMenu(row.id); }
      },
      onContextMenu: event => { event.preventDefault(); if (!pointerDragging.current) setMenu(row.id); },
      onDragStart: event => event.preventDefault(),
    }, <button className="icon-button project-actions" aria-label={`${t.projectActions}: ${row.name}`} aria-haspopup="menu" aria-expanded={menu === row.id}
      onClick={() => setMenu(menu === row.id ? undefined : row.id)}>…</button>)}
    {menu === row.id && <div role="menu" aria-label={`${t.projectActions}: ${row.name}`} className="project-actions-menu" onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); focusRow(row.id); }
    }}>
      <button className="btn btn-ghost" role="menuitem" disabled={index === 0} onClick={() => move(row.id, index - 1)}>{t.moveUp}</button>
      <button className="btn btn-ghost" role="menuitem" disabled={index === visible.length - 1} onClick={() => move(row.id, index + 1)}>{t.moveDown}</button>
      <button className="btn btn-ghost" role="menuitem" onClick={() => { setSaved({ ...preferences, hidden: [...preferences.hidden, row.id] }); setMenu(undefined); }}>{t.hideFromList}</button>
    </div>}
  </div>)}{hidden.length > 0 && <details className="hidden-projects"><summary>{t.hiddenProjects} {hidden.length}</summary>{hidden.map(row => <div key={row.id} className="hidden-project-row">
    <span className="truncate" title={row.full}>{row.name}</span><button className="btn btn-ghost btn-xs" aria-label={`${t.showInList}: ${row.name}`} onClick={() => setSaved({ ...preferences, hidden: preferences.hidden.filter(id => id !== row.id) })}>{t.showInList}</button>
  </div>)}</details>}</nav>;
}
