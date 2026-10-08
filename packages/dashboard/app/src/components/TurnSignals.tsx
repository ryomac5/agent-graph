import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { createKeyHandler, type KeyBindings } from '../lib/keys.ts';
import { store, useScreenStore, type ScreenStore } from '../lib/store.ts';
import { orderSeries, rootProject, selectRoots, type Root } from '../lib/roots.ts';
import { OTHER_PROJECT, getRegisteredProjects, resolveProjectId } from '../lib/projects.ts';
import { publishTurns, readHistory, recordTransitions, rememberConversation, selectTurns, useTurns, READ_KEY, READY_KEY, RECENT_KEY } from '../lib/turns.ts';

export function TabBadge({ count }: { count: number }) {
  useEffect(() => {
    const title = document.title;
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const original = icon?.getAttribute('href');
    const type = icon?.getAttribute('type');
    const created = !icon;
    document.title = count ? `(${count}) agent-graph` : 'agent-graph';
    let disposed = false;
    if (count) {
      icon ??= document.createElement('link'); icon.rel = 'icon';
      if (created) document.head.append(icon);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      const draw = (base?: CanvasImageSource) => {
        if (!context || disposed) return;
        context.clearRect(0, 0, 32, 32);
        if (base) context.drawImage(base, 0, 0, 32, 32);
        else { context.fillStyle = '#0031D8'; context.fillRect(0, 0, 32, 32); }
        context.fillStyle = '#FA0000'; context.beginPath(); context.arc(23, 23, 9, 0, Math.PI * 2); context.fill();
        context.fillStyle = '#fff'; context.font = 'bold 12px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.fillText(count > 99 ? '99+' : String(count), 23, 23, 17);
        icon!.href = canvas.toDataURL('image/png'); icon!.type = 'image/png';
      };
      draw();
      if (original) { const image = new Image(); image.onload = () => draw(image); image.src = original; }
    }
    return () => {
      disposed = true; document.title = title;
      if (created) icon?.remove();
      else if (icon) {
        if (original === null || original === undefined) icon.removeAttribute('href'); else icon.setAttribute('href', original);
        if (type === null || type === undefined) icon.removeAttribute('type'); else icon.setAttribute('type', type);
      }
    };
  }, [count]);
  return null;
}

export function TurnSignals({ target = store, bindings }: { target?: ScreenStore; bindings: KeyBindings }) {
  const state = useScreenStore(target);
  const location = useLocation(); const navigate = useNavigate();
  const previous = useRef<Root[]>([]);
  const opened = useRef('');
  const saved = useRef<ReturnType<typeof readHistory> | null>(null);
  saved.current ??= readHistory();
  const [storageRevision, setStorageRevision] = useState(0);
  const { turns, history } = useTurns();
  useLayoutEffect(() => {
    const roots = selectRoots(state);
    let next = recordTransitions(previous.current, roots, saved.current!);
    previous.current = roots;
    const search = new URLSearchParams(location.search);
    const direct = /^\/c\/([^/]+)$/.exec(location.pathname);
    const projectPath = /^\/p\/([^/]+)$/.exec(location.pathname);
    const project = projectPath ? resolveProjectId(state, decodeURIComponent(projectPath[1])) : undefined;
    const registered = new Set(getRegisteredProjects(state).map(row => String(row.id)));
    const projectRoots = roots.filter(row => row.project === project || project === OTHER_PROJECT && rootProject(row, registered) === OTHER_PROJECT);
    const root = projectPath ? projectRoots.find(row => row.id === search.get('root')) ?? projectRoots[0] : undefined;
    const id = direct ? decodeURIComponent(direct[1]) : root ? search.get('child') ?? orderSeries(state, root.conversation_ids).at(-1) : undefined;
    if (id) {
      if (opened.current !== id) next = rememberConversation(next, id);
      // 系列の会話は同じ画面で読めるので、根を開いたときは系列全体を既読にする。
      const ids = root && !search.has('child') || direct && roots.some(row => row.conversation_ids.includes(id))
        ? (root ?? roots.find(row => row.conversation_ids.includes(id)))!.conversation_ids : [id];
      for (const conversation of ids) if (document.visibilityState === 'visible' && next.ready[conversation]) next = { ...next, read: { ...next.read, [conversation]: next.ready[conversation] } };
    }
    opened.current = id ?? '';
    localStorage.setItem(READ_KEY, JSON.stringify(next.read));
    localStorage.setItem(READY_KEY, JSON.stringify(next.ready));
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.recent));
    saved.current = next;
    publishTurns({ state, navigate, history: next, turns: selectTurns(state, next, roots) });
  }, [state, location.pathname, location.search, storageRevision, navigate]);
  useEffect(() => () => publishTurns(), []);
  useEffect(() => {
    const approval = new URLSearchParams(location.search).get('approval');
    if (location.pathname === '/inbox' && approval) {
      const row = [...document.querySelectorAll<HTMLElement>('[data-approval-id]')].find(row => row.dataset.approvalId === approval);
      row?.focus(); row?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [location.pathname, location.search, state.projection.approvals]);
  useEffect(() => {
    function sync() { saved.current = readHistory(); setStorageRevision(value => value + 1); }
    function show() { setStorageRevision(value => value + 1); }
    window.addEventListener('storage', sync);
    document.addEventListener('visibilitychange', show);
    return () => { window.removeEventListener('storage', sync); document.removeEventListener('visibilitychange', show); };
  }, []);
  useEffect(() => {
    const extra = Object.fromEntries(Object.entries(bindings).filter(([key]) => key === 'nextTurn' || key.startsWith('recent')));
    let executed = false;
    const handle = createKeyHandler(extra, action => {
      executed = true;
      if (action === 'nextTurn') {
        const index = turns.findIndex(turn => turn.to === `${location.pathname}${location.search}`);
        const next = turns[(index + 1) % turns.length]; if (next) navigate(next.to);
      } else {
        const id = history.recent[Number(action.replace('recent', '')) - 1]; if (id) navigate(`/c/${encodeURIComponent(id)}`);
      }
    });
    function onKey(event: KeyboardEvent) {
      if (document.querySelector('[role="dialog"]')) return;
      executed = false;
      handle(event);
      if (executed) { event.preventDefault(); event.stopImmediatePropagation(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [bindings, turns, history.recent, location.pathname, location.search, navigate]);
  return <TabBadge count={turns.length}/>;
}
