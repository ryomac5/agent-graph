import { VisibleView } from '../../lib/visibility.tsx';
import { shareValue } from '../../lib/projection-cache.ts';
import { WorkspaceTabButton } from '../../components/conversation/WorkingClock.tsx';
import { FeatureErrorBoundary } from '../../components/FeatureErrorBoundary.tsx';
import { StatusDot } from '../../components/StateBadge.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ResizeDivider } from '../../components/ResizeDivider.tsx';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { type CodeDocument } from '../../lib/code-document.ts';
import { getFileDocument } from '../../lib/file-documents.ts';
import { DEFAULT_KEYS, createKeyHandler, type KeyBindings } from '../../lib/keys.ts';
import { closePane, closeTab, createWorkspace, listPanes, moveTab, resizeSplit, restoreWorkspace, migrateWorkspaceSeries, splitAndMoveTab, splitPane, updatePane, workspaceKey, type PaneTree, type WorkspaceTab } from '../../lib/panes.ts';
import { OpenWorkspaceConversation, OpenWorkspaceFile, OpenWorkspaceTerminal, WorkspaceConversationHeader, type ConversationTabMetadata } from '../../lib/workspace-context.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { useTabDrag } from './useTabDrag.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { LoadingFeature } from '../../components/LoadingFeature.tsx';
import { TerminalTab, createTerminalSession, type TerminalSession } from './TerminalTab.tsx';
import { FilePicker } from './FilePicker.tsx';
import { createPortal } from 'react-dom';
import './workbench.css';
const CodeTab = lazy(() => import('./CodeTab.tsx').then(module => ({ default: module.CodeTab })));
const WHEEL_LINE_HEIGHT = 16;
const id = () => crypto.randomUUID();
function fileKey(tab: Extract<WorkspaceTab, { kind: 'code' }>) { return JSON.stringify([tab.worktree ?? '', tab.path]); }
function matchesTab(a: WorkspaceTab, b: WorkspaceTab): boolean {
  if (a.kind === 'conversation' && b.kind === 'conversation') return a.conversationId ? a.conversationId === b.conversationId : a.id === b.id;
  if (a.kind === 'code' && b.kind === 'code') return fileKey(a) === fileKey(b);
  return a.kind === 'terminal' && b.kind === 'terminal' && (a.id === b.id || !!a.terminalId && a.terminalId === b.terminalId);
}
function mergeTab(tree: PaneTree | null, tab: WorkspaceTab, focused?: string, keepIncoming = false): { tree: PaneTree; pane: string } {
  if (!tree) { const pane = id(); return { tree: { kind: 'pane', id: pane, tabs: [tab], active: tab.id }, pane }; }
  const panes = listPanes(tree);
  const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(item => matchesTab(item.tab, tab));
  const pane = existing?.pane ?? panes.find(pane => pane.id === focused) ?? panes[0];
  return { pane: pane.id, tree: updatePane(tree, pane.id, pane => ({ ...pane,
    tabs: existing ? pane.tabs.map(item => item.id === existing.tab.id && keepIncoming ? { ...item, ...tab } : item) : [...pane.tabs, tab],
    active: existing && !keepIncoming ? existing.tab.id : tab.id,
  })) };
}
// 別の作業場で使われた initial-tab 等を、現在の入力や端末と取り違えない。
function renewWorkspaceIds(tree: PaneTree | null, newSession?: string): PaneTree | null {
  if (!tree) return null;
  if (tree.kind === 'split') return { ...tree, id: id(), first: renewWorkspaceIds(tree.first, newSession)!, second: renewWorkspaceIds(tree.second, newSession)! };
  const ids = new Map(tree.tabs.map(tab => [tab.id, tab.id === newSession ? tab.id : id()]));
  return { ...tree, id: id(), tabs: tree.tabs.map(tab => ({ ...tab, id: ids.get(tab.id)! })), active: tree.active ? ids.get(tree.active) : undefined };
}
function mergeWorkspace(saved: PaneTree | null, pending: PaneTree | null, focused: string): { tree: PaneTree | null; focused: string } {
  if (!saved || !pending) return { tree: pending ?? saved, focused };
  let tree = saved;
  let destination = listPanes(saved)[0].id;
  // 待機中のタブの ID を優先し、入力を持つ描画先を保つ。
  for (const pane of listPanes(pending)) {
    for (const tab of pane.tabs) {
      const merged = mergeTab(tree, tab, destination, true);
      tree = merged.tree;
      if (pane.id === focused && tab.id === pane.active) destination = merged.pane;
    }
  }
  const active = listPanes(pending).find(pane => pane.id === focused)?.active;
  const pane = listPanes(tree).find(pane => pane.tabs.some(tab => tab.id === active));
  if (pane) tree = updatePane(tree, pane.id, pane => ({ ...pane, active }));
  return { tree, focused: pane?.id ?? destination };
}
function CodeLabel({ document, name, language }: { document: CodeDocument; name: string; language: Language }) {
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  return <>{name}{state.dirty && <span aria-label={language === 'ja' ? '未保存' : 'Unsaved'}> ●</span>}{state.external && <span aria-label={language === 'ja' ? '外で変更' : 'Changed on disk'}> !</span>}</>;
}
export function Workbench({ project, session, unresolvedConversationId, conversationId, client, language, bindings = DEFAULT_KEYS, renderConversation, registerOpenFile, newSession, openConversationId, refreshTab, seriesIds = [], currentConversationId = conversationId, resolveRenameRoot }: {
  project: string; session?: string; conversationId: string; client: ConversationClient; language: Language; bindings?: KeyBindings;
  unresolvedConversationId?: string; seriesIds?: readonly string[]; currentConversationId?: string; resolveRenameRoot?: (id: string) => string | undefined;
  refreshTab?: (conversationId: string, previous: ConversationTabMetadata) => ConversationTabMetadata;
  openConversationId?: string; newSession?: string; renderConversation: (conversationId: string, onConversation: (id: string) => void) => ReactNode; registerOpenFile?: RefObject<(path: string, worktree?: string) => void>;
}) {
  const [reportedConversationTabs, setConversationTabs] = useState<Record<string, ConversationTabMetadata>>({});
  const reportConversation = useCallback((tabId: string, metadata: ConversationTabMetadata) => {
    setConversationTabs(previous => {
      const current = previous[tabId];
      return current?.name === metadata.name && current.state === metadata.state && current.title === metadata.title && current.autoName === metadata.autoName && current.startedAt === metadata.startedAt && current.elapsedEnabled === metadata.elapsedEnabled && current.elapsedStarted === metadata.elapsedStarted && current.elapsedLabel === metadata.elapsedLabel && current.model === metadata.model ? previous : { ...previous, [tabId]: metadata };
    });
  }, []);
  const key = session === undefined ? undefined : workspaceKey(project, session);
  function readWorkspace(saved: string | null): PaneTree | null {
    if (!saved && newSession && !conversationId) return { kind: 'pane', id: 'initial-pane', tabs: [{ kind: 'conversation', id: newSession, conversationId: '' }], active: newSession };
    return restoreWorkspace(saved, saved ? currentConversationId : conversationId, saved ? seriesIds : []);
  }
  const [tree, setTree] = useState<PaneTree | null>(() => readWorkspace(key === undefined ? null : localStorage.getItem(key)));
  if (tree) { const migrated = migrateWorkspaceSeries(tree, currentConversationId, seriesIds); if (migrated !== tree) setTree(migrated); }
  const [focused, setFocused] = useState(() => tree ? listPanes(tree)[0].id : '');
  const [workspace, setWorkspace] = useState({ key, unresolvedConversationId, generation: 0, migratedKey: undefined as string | undefined });
  if (workspace.key !== key || workspace.unresolvedConversationId !== unresolvedConversationId) {
    const carry = !!workspace.unresolvedConversationId && workspace.unresolvedConversationId === (openConversationId ?? conversationId);
    const saved = key === undefined ? null : localStorage.getItem(key);
    const restored = renewWorkspaceIds(readWorkspace(saved), newSession);
    const next = carry ? mergeWorkspace(saved ? restored : null, tree, focused) : { tree: restored, focused: restored ? listPanes(restored)[0].id : '' };
    // 木と保存先を同じ描画で切り替え、古い木を新しい鍵に書かせない。
    setTree(next.tree);
    setFocused(next.focused);
    setWorkspace({ key, unresolvedConversationId, generation: workspace.generation + (carry ? 0 : 1), migratedKey: carry ? workspace.migratedKey ?? (workspace.key !== key ? workspace.key : undefined) : undefined });
  }
  const [menu, setMenu] = useState<string>(), [picker, setPicker] = useState<{ pane: string; worktree?: string }>();
  const [renaming, setRenaming] = useState<{ pane: string; tab: string; value: string }>();
  const [tabMenu, setTabMenu] = useState<{ pane: string; tab: WorkspaceTab; x: number; y: number }>();
  const openedSession = useRef<string | undefined>(undefined);
  const openedConversation = useRef(openConversationId);
  const [restart, setRestart] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const documents = useRef(new Map<string, CodeDocument>());
  const terminals = useRef(new Map<string, TerminalSession>());
  const bodies = useRef(new Map<string, HTMLDivElement>());
  const headers = useRef(new Map<string, { back: HTMLDivElement; actions: HTMLDivElement }>());
  const tabMenuRoot = useRef<HTMLDivElement>(null);
  const ja = language === 'ja';
  const text = dictionaries[language];
  const tabDrag = useTabDrag(root, (tab, target) => {
    const paneId = target.edge ? id() : target.pane;
    const splitId = id();
    setTree(current => current && (target.edge ? splitAndMoveTab(current, tab, target.pane, target.edge, paneId, splitId) : moveTab(current, tab, target.pane, target.before)));
    setFocused(paneId);
  });
  useLayoutEffect(() => {
    if (!tabMenu) return;
    const element = tabMenuRoot.current;
    if (element) {
      const bounds = element.getBoundingClientRect();
      element.style.left = Math.max(0, Math.min(tabMenu.x, window.innerWidth - bounds.width)) + 'px';
      element.style.top = Math.max(0, Math.min(tabMenu.y, window.innerHeight - bounds.height)) + 'px';
    }
    tabMenuRoot.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => { if (!(event.target as Element).closest('.workbench-menu')) setTabMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTabMenu(undefined); document.getElementById(`workspace-tab-${tabMenu.tab.id}`)?.focus(); } };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [tabMenu]);
  useEffect(() => {
    if (!menu) return;
    root.current?.querySelector<HTMLElement>('.workbench-add .workbench-menu [role="menuitem"]')?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); root.current?.querySelector<HTMLElement>('[data-pane-id="' + CSS.escape(menu) + '"] .workbench-add > button')?.focus(); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [menu]);
  const panes = tree ? listPanes(tree) : [];
  const previousTabs = useRef<Record<string, ConversationTabMetadata>>({});
  const conversationTabs = useMemo(() => {
    const next = { ...reportedConversationTabs };
    if (refreshTab) for (const pane of tree ? listPanes(tree) : []) for (const tab of pane.tabs) {
      if (tab.kind === 'conversation' && tab.id !== pane.active && next[tab.id]) next[tab.id] = refreshTab(tab.conversationId, next[tab.id]);
    }
    return previousTabs.current = shareValue(previousTabs.current, next);
  }, [tree, reportedConversationTabs, refreshTab]);
  const focusedPane = panes.find(pane => pane.id === focused) ?? panes[0];
  const activeTab = focusedPane?.tabs.find(tab => tab.id === focusedPane.active);
  useEffect(() => {
    if (!newSession || openedSession.current === newSession) return;
    openedSession.current = newSession;
    const tab: WorkspaceTab = { kind: 'conversation', id: newSession, conversationId: '' };
    setTree(current => {
      if (current && listPanes(current).some(pane => pane.tabs.some(tab => tab.id === newSession))) return current;
      const paneId = current ? listPanes(current).find(pane => pane.id === focused)?.id ?? listPanes(current)[0].id : id();
      return current ? updatePane(current, paneId, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })) : { kind: 'pane', id: paneId, tabs: [tab], active: tab.id };
    });
  }, [newSession]);
  useEffect(() => {
    const requested = openConversationId ?? (openedConversation.current ? conversationId : undefined);
    openedConversation.current = openConversationId;
    if (!requested) return;
    setTree(current => {
      const merged = mergeTab(current, { kind: 'conversation', id: id(), conversationId: seriesIds.includes(requested) ? currentConversationId : requested }, focused);
      setFocused(merged.pane);
      return merged.tree;
    });
  }, [openConversationId, workspace.generation]);
  function label(tab: WorkspaceTab) { return tab.name || (tab.kind === 'code' ? tab.path.split('/').at(-1)! : tab.kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : tab.conversationId ? conversationTabs[tab.id]?.name || (ja ? '会話' : 'Conversation') : ja ? '新しいセッション' : 'New session'); }
  function displayLabel(tab: WorkspaceTab) {
    const name = label(tab);
    if (tab.kind !== 'conversation') return name;
    const matches = panes.flatMap(pane => pane.tabs).filter(other => other.kind === 'conversation' && label(other) === name);
    if (matches.length < 2) return name;
    const suffix = (other: WorkspaceTab) => {
      const metadata = conversationTabs[other.id];
      const title = metadata?.autoName || metadata?.title.split(' · ')[0] || '';
      const date = title.match(/(?:^|-)(\d{8}(?:-\d+)?)$/)?.[1];
      if (date) return date;
      const started = metadata?.startedAt ? new Date(metadata.startedAt) : undefined;
      return started && Number.isFinite(started.getTime()) ? started.toLocaleString(ja ? 'ja-JP' : 'en-GB') : title !== name ? title : '';
    };
    const value = suffix(tab);
    const duplicates = matches.filter(other => suffix(other) === value);
    const number = duplicates.length > 1 || !value ? String(duplicates.findIndex(other => other.id === tab.id) + 1) : '';
    return name + ' · ' + [value, number].filter(Boolean).join(' · ');
  }
  useEffect(() => {
    for (const pane of panes) document.getElementById('workspace-tab-' + pane.active)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tree, conversationTabs]);
  useEffect(() => {
    const element = root.current;
    function scrollTabs(event: WheelEvent) {
      const list = (event.target as Element).closest<HTMLElement>('.workbench-tablist');
      if (!list || event.ctrlKey || event.deltaX || !event.deltaY || list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      const distance = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_HEIGHT : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? list.clientWidth : 1;
      list.scrollLeft += event.deltaY * distance;
    }
    element?.addEventListener('wheel', scrollTabs, { passive: false });
    return () => element?.removeEventListener('wheel', scrollTabs);
  }, []);
  function beginRename(pane: string, tab: WorkspaceTab) { setRenameError(''); setRenaming({ pane, tab: tab.id, value: label(tab) }); setTabMenu(undefined); }
  const [renameError, setRenameError] = useState('');
  const renamePending = useRef(false);
  async function finishRename() {
    if (!renaming || renamePending.current) return;
    const { pane, tab, value } = renaming;
    const item = tree && listPanes(tree).flatMap(node => node.tabs).find(item => item.id === tab);
    if (item?.kind === 'conversation' && item.conversationId) {
      renamePending.current = true;
      setRenameError('');
      try {
        const ack = await client.command('session.rename', { rootId: resolveRenameRoot?.(item.conversationId) ?? item.conversationId, name: value.trim() });
        if (!ack.ok) throw new Error(ack.error);
      } catch { setRenameError(ja ? '名前を変更できませんでした' : 'Unable to rename'); return; }
      finally { renamePending.current = false; }
    }
    setTree(current => current && updatePane(current, pane, node => ({ ...node, tabs: node.tabs.map(item => item.id === tab ? { ...item, name: item.kind === 'conversation' && item.conversationId ? undefined : value.trim() || undefined } : item) })));
    setRenaming(undefined);
  }
  function replaceConversation(paneId: string, tabId: string, conversationId: string) {
    setTree(current => current && updatePane(current, paneId, pane => ({ ...pane, tabs: pane.tabs.map(tab => tab.id === tabId && tab.kind === 'conversation' ? { ...tab, conversationId } : tab) })));
  }
  function getDocument(tab: Extract<WorkspaceTab, { kind: 'code' }>) {
    const key = fileKey(tab);
    if (!documents.current.has(key)) documents.current.set(key, getFileDocument(client, { projectId: project, path: tab.path, ...(tab.worktree ? { worktree: tab.worktree } : {}) }));
    return documents.current.get(key)!;
  }
  function getTerminal(tab: Extract<WorkspaceTab, { kind: 'terminal' }>) {
    if (!terminals.current.has(tab.id)) terminals.current.set(tab.id, createTerminalSession(client, project, tab.worktree, tab.terminalId));
    return terminals.current.get(tab.id)!;
  }
  useEffect(() => {
    if (key === undefined || workspace.key !== key) return;
    localStorage.setItem(key, JSON.stringify(tree));
    if (workspace.migratedKey && workspace.migratedKey !== key) localStorage.removeItem(workspace.migratedKey);
  }, [key, tree, workspace]);
  useEffect(() => {
    const live = new Set(panes.flatMap(pane => pane.tabs).map(tab => tab.id));
    for (const [tabId, terminal] of terminals.current) if (!live.has(tabId)) { terminal.dispose(); terminals.current.delete(tabId); }
    for (const tabId of bodies.current.keys()) if (!live.has(tabId)) bodies.current.delete(tabId);
    for (const tabId of headers.current.keys()) if (!live.has(tabId)) headers.current.delete(tabId);
    const liveFiles = new Set(panes.flatMap(pane => pane.tabs).filter(tab => tab.kind === 'code').map(fileKey));
    for (const key of documents.current.keys()) if (!liveFiles.has(key)) documents.current.delete(key);
  }, [tree]);
  useEffect(() => () => { for (const terminal of terminals.current.values()) terminal.dispose(); }, []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if ([...documents.current.values()].some(document => document.getSnapshot().dirty)) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, []);
  const openFile = useCallback((path: string, worktree?: string, paneId?: string) => {
    const destination = panes.find(pane => pane.id === paneId) ?? focusedPane;
    const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'code' && tab.path === path && (tab.worktree ?? '') === (worktree ?? ''));
    if (existing && destination?.tabs.length !== 0) { setFocused(existing.pane.id); setTree(tree => tree && updatePane(tree, existing.pane.id, pane => ({ ...pane, active: existing.tab.id }))); requestAnimationFrame(() => root.current?.focus()); return; }
    const tab: WorkspaceTab = { kind: 'code', id: id(), path, ...(worktree ? { worktree } : {}) };
    if (destination) { setTree(tree => tree && updatePane(tree, destination.id, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id }))); setFocused(destination.id); }
    else { const paneId = id(); setTree({ kind: 'pane', id: paneId, tabs: [tab], active: tab.id }); setFocused(paneId); }
    requestAnimationFrame(() => root.current?.focus());
  }, [tree, focused]);
  useEffect(() => { if (registerOpenFile) registerOpenFile.current = openFile; }, [registerOpenFile, openFile]);
  function addTab(kind: 'conversation' | 'terminal', paneId: string) {
    if (kind === 'conversation' && conversationId) {
      const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'conversation' && tab.conversationId === conversationId);
      if (existing) {
        setTree(current => current && updatePane(current, existing.pane.id, pane => ({ ...pane, active: existing.tab.id })));
        setFocused(existing.pane.id); setMenu(undefined); return;
      }
    }
    const tab: WorkspaceTab = kind === 'conversation' ? { kind, id: id(), conversationId } : { kind, id: id(), ...(activeTab && 'worktree' in activeTab && activeTab.worktree ? { worktree: activeTab.worktree } : {}) };
    setTree(tree => tree ? updatePane(tree, paneId, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })) : { kind: 'pane', id: paneId, tabs: [tab], active: tab.id }); setFocused(paneId); setMenu(undefined);
  }
  function openTerminal(terminalId: string, sourcePane: string) {
    const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'terminal' && tab.terminalId === terminalId);
    if (existing) { setFocused(existing.pane.id); setTree(tree => tree && updatePane(tree, existing.pane.id, pane => ({ ...pane, active: existing.tab.id }))); return; }
    const tab: WorkspaceTab = { kind: 'terminal', id: id(), terminalId };
    const neighbor = panes.find(pane => pane.id !== sourcePane);
    const paneId = neighbor?.id ?? id();
    setTree(tree => tree && (neighbor ? updatePane(tree, paneId, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })) : splitPane(tree, sourcePane, 'horizontal', paneId, id(), tab)));
    setFocused(paneId);
  }
  function split(direction: 'horizontal' | 'vertical') {
    if (!focusedPane) return;
    const paneId = id();
    setTree(tree => tree && splitPane(tree, focusedPane.id, direction, paneId, id())); setFocused(paneId);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)?.focus());
  }
  const actions = useRef<(action: string) => void>(() => {});
  actions.current = action => {
    if (action === 'splitHorizontal') split('horizontal'); else if (action === 'splitVertical') split('vertical');
    else if (action === 'openFile') setPicker({ pane: focusedPane?.id ?? id(), worktree: activeTab && 'worktree' in activeTab ? activeTab.worktree : undefined });
    else if (action === 'saveFile' && activeTab?.kind === 'code') void getDocument(activeTab).save();
  };
  const handler = useMemo(() => createKeyHandler({ splitHorizontal: bindings.splitHorizontal, splitVertical: bindings.splitVertical, openFile: bindings.openFile, saveFile: bindings.saveFile }, action => actions.current(action)), [bindings]);
  function close(tab: WorkspaceTab) {
    if (tab.kind === 'code' && getDocument(tab).getSnapshot().dirty && !window.confirm(ja ? '保存していない変更を捨てますか？' : 'Discard unsaved changes?')) return;
    if (tab.kind === 'code' && panes.flatMap(pane => pane.tabs).filter(other => other.kind === 'code' && fileKey(other) === fileKey(tab)).length === 1) getDocument(tab).discard();
    setTree(tree => tree && closeTab(tree, tab.id));
    requestAnimationFrame(() => root.current?.focus());
  }
  function splitTab(pane: string, tab: WorkspaceTab, edge: 'right' | 'bottom') {
    const paneId = id(), splitId = id();
    setTree(current => current && splitAndMoveTab(current, tab.id, pane, edge, paneId, splitId));
    setFocused(paneId); setTabMenu(undefined);
  }
  const openConversation = useCallback((conversationId: string): boolean => {
    if (!focusedPane || focusedPane.tabs.length) return false;
    const tab: WorkspaceTab = { kind: 'conversation', id: id(), conversationId };
    setTree(tree => tree && updatePane(tree, focusedPane.id, pane => ({ ...pane, tabs: [tab], active: tab.id })));
    return true;
  }, [tree, focused]);
  function focusPane(paneId: string, target: EventTarget) {
    if (focusedPane?.tabs.length === 0 && target instanceof Element && target.closest('.delegation-card')) return;
    setFocused(paneId);
  }
  // 保存済みの分割へ合流しても、会話とエディタの入力を持つ要素は移動だけにする。
  function getBody(tabId: string) {
    if (!bodies.current.has(tabId)) {
      const element = document.createElement('div');
      element.style.display = 'contents';
      bodies.current.set(tabId, element);
    }
    return bodies.current.get(tabId)!;
  }
  function attachHeader(element: HTMLElement | null, tabId: string, slot: 'back' | 'actions', hidden: boolean) {
    if (!element) return;
    if (!headers.current.has(tabId)) {
      const back = document.createElement('div'), actions = document.createElement('div');
      back.id = `workspace-back-${tabId}`; back.className = 'workbench-back';
      actions.id = `workspace-actions-${tabId}`; actions.className = 'workbench-actions';
      headers.current.set(tabId, { back, actions });
    }
    const host = headers.current.get(tabId)![slot];
    host.hidden = hidden;
    if (host.parentElement !== element) element.append(host);
  }
  function renderTree(node: PaneTree): ReactNode {
    if (node.kind === 'split') return <div className={`workbench-split ${node.direction}`} key={node.id}>
      <div className="split-child" style={{ flexGrow: node.ratio }}>{renderTree(node.first)}</div>
      <ResizeDivider label={ja ? '区画の大きさ' : 'Pane size'} orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'} value={Math.round(node.ratio * 100)} min={10} max={90}
        onChange={value => setTree(tree => tree && resizeSplit(tree, node.id, value / 100))}
        onReset={() => setTree(tree => tree && resizeSplit(tree, node.id, 0.5))}
        onDrag={(delta, bounds) => { const size = (node.direction === 'horizontal' ? bounds.width : bounds.height) - 6; if (size > 0) setTree(tree => tree && resizeSplit(tree, node.id, node.ratio + delta / size)); }}
        /><div className="split-child" style={{ flexGrow: 1 - node.ratio }}>{renderTree(node.second)}</div></div>;
    return <section className="workbench-pane" key={node.id} tabIndex={-1} data-pane-id={node.id} data-focused={focusedPane?.id === node.id} onFocusCapture={event => focusPane(node.id, event.target)} onPointerDownCapture={event => focusPane(node.id, event.target)}>
      <header className="workbench-tabs">
        {node.tabs.filter(tab => tab.kind === 'conversation').map(tab => <span key={tab.id} className="workbench-back" style={{ display: 'contents' }} ref={element => attachHeader(element, tab.id, 'back', tab.id !== node.active)}/>)}
        <div className="workbench-tablist" role="tablist" aria-label={ja ? 'ワークスペースのタブ' : 'Workspace tabs'}>{node.tabs.map(tab => <div className="workbench-tab" key={tab.id} data-tab-id={tab.id} data-dragging={tabDrag.dragging === tab.id} data-drop-before={tabDrag.preview?.pane === node.id && tabDrag.preview?.tablist && tabDrag.preview.before === tab.id} onPointerDown={event => { setTabMenu(undefined); if (event.button === 1) event.preventDefault(); tabDrag.begin(event, tab.id); }} onClickCapture={event => { if (tabDrag.suppressClick.current) { tabDrag.suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
          onContextMenu={event => { event.preventDefault(); if (tabDrag.active.current) return; const bounds = event.currentTarget.getBoundingClientRect(); setTabMenu({ pane: node.id, tab, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom }); }}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab); } }}>
          {renaming?.tab === tab.id ? <input className="input-sm" autoFocus aria-label={ja ? 'タブの名前' : 'Tab name'} value={renaming.value} onFocus={event => event.currentTarget.select()} onChange={event => setRenaming({ ...renaming, value: event.target.value })} onBlur={() => void finishRename()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); void finishRename(); } else if (event.key === 'Escape') { event.preventDefault(); setRenaming(undefined); } }}/>
          : <WorkspaceTabButton metadata={tab.kind === 'conversation' ? conversationTabs[tab.id] : undefined} onDoubleClick={() => beginRename(node.id, tab)} role="tab" id={`workspace-tab-${tab.id}`} aria-label={tab.kind === 'conversation' ? displayLabel(tab) : undefined} aria-controls={`workspace-body-${tab.id}`} aria-selected={tab.id === node.active} title={tab.kind === 'code' ? tab.path : tab.kind === 'conversation' ? displayLabel(tab) + (conversationTabs[tab.id]?.title ? ' · ' + conversationTabs[tab.id].title : '') : undefined} onClick={() => { setFocused(node.id); setTree(tree => tree && updatePane(tree, node.id, pane => ({ ...pane, active: tab.id }))); }}>{tab.kind === 'conversation' && conversationTabs[tab.id] && <StatusDot state={conversationTabs[tab.id].state} language={language} dotOnly activity/>}<span className="truncate">{tab.kind === 'code' ? <CodeLabel document={getDocument(tab)} language={language} name={label(tab)}/> : label(tab)}</span>{tab.kind === 'conversation' && displayLabel(tab) !== label(tab) && <span className="workbench-tab-suffix">{displayLabel(tab).slice(label(tab).length)}</span>}</WorkspaceTabButton>}
          <button className="icon-button" aria-label={`${ja ? '閉じる' : 'Close'} ${tab.kind === 'code' ? tab.path : tab.kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? '会話' : 'Conversation'}`} onClick={() => close(tab)}>×</button>
        </div>)}</div>
        {tabDrag.preview?.pane === node.id && tabDrag.preview.tablist && <span className="workbench-drop-end" style={{ left: tabDrag.preview.line }}/>}
        <div className="workbench-add"><button className="icon-button" aria-label={ja ? 'タブを開く' : 'Open tab'} aria-expanded={menu === node.id} onClick={() => setMenu(menu === node.id ? undefined : node.id)}>+</button>
          {menu === node.id && <div className="workbench-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('button')?.focus(); } }}>{(['conversation', 'terminal', 'file'] as const).map(kind => <button className="btn btn-ghost" role="menuitem" key={kind} onClick={() => { if (kind === 'file') { setPicker({ pane: node.id, worktree: activeTab && 'worktree' in activeTab ? activeTab.worktree : undefined }); setMenu(undefined); } else addTab(kind, node.id); }}>{kind === 'conversation' ? ja ? '会話' : 'Conversation' : kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? 'ファイルを開く' : 'Open file'}</button>)}</div>}</div>
        {node.tabs.filter(tab => tab.kind === 'conversation').map(tab => <span key={tab.id} style={{ display: 'contents' }} ref={element => attachHeader(element, tab.id, 'actions', tab.id !== node.active)}/>)}
        {!node.tabs.length && <button className="icon-button" aria-label={ja ? '区画を閉じる' : 'Close pane'} onClick={() => { setTree(tree => tree && closePane(tree, node.id)); requestAnimationFrame(() => root.current?.focus()); }}>×</button>}
        {tabMenu?.pane === node.id && <div className="workbench-menu workbench-tab-menu" role="menu" ref={tabMenuRoot} style={{ left: tabMenu.x, top: tabMenu.y }} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const index = items.indexOf(document.activeElement as HTMLElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
          items[next]?.focus();
        }}>
          <button className="btn btn-ghost" role="menuitem" onClick={() => splitTab(node.id, tabMenu.tab, 'right')}>{text.splitRight}</button>
          <button className="btn btn-ghost" role="menuitem" onClick={() => splitTab(node.id, tabMenu.tab, 'bottom')}>{text.splitDown}</button>
          <button className="btn btn-ghost" role="menuitem" disabled={panes.length < 2} onClick={() => { const next = panes[(panes.findIndex(pane => pane.id === node.id) + 1) % panes.length]; setTree(current => current && moveTab(current, tabMenu.tab.id, next.id)); setFocused(next.id); setTabMenu(undefined); }}>{text.moveToOtherPane}</button>
          <button className="btn btn-ghost" role="menuitem" onClick={() => { close(tabMenu.tab); setTabMenu(undefined); }}>{text.close}</button>
          <button className="btn btn-ghost" role="menuitem" onClick={() => { for (const tab of node.tabs) if (tab.id !== tabMenu.tab.id) close(tab); setTabMenu(undefined); }}>{text.closeOthers}</button>
          <button className="btn btn-ghost" role="menuitem" onClick={() => beginRename(node.id, tabMenu.tab)}>{ja ? '名前を変える' : 'Rename'}</button>
        </div>}
      </header>
      {!node.tabs.length && <div className="workbench-empty"><div className="empty-state">
        <Icon name="overview" size={20}/><h2>{ja ? '空の区画' : 'Empty pane'}</h2>
        <div className="workbench-empty-actions">
          <button className="btn btn-secondary" onClick={() => addTab('conversation', node.id)}>{ja ? '会話を開く' : 'Open conversation'}</button>
          <button className="btn btn-ghost" onClick={() => addTab('terminal', node.id)}>{ja ? 'ターミナルを開く' : 'Open terminal'}</button>
          <button className="btn btn-ghost" onClick={() => setPicker({ pane: node.id })}>{ja ? 'ファイルを開く' : 'Open file'}</button>
        </div>
      </div></div>}
      {node.tabs.map(tab => <div key={tab.id} role="tabpanel" id={`workspace-body-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={tab.id !== node.active} className="workbench-body" ref={element => { const body = getBody(tab.id); if (element && body.parentElement !== element) element.append(body); }}/>)}
      {tabDrag.preview?.pane === node.id && !tabDrag.preview.tablist && <div className={`workbench-drop-preview ${tabDrag.preview.edge ?? 'center'}`} aria-hidden="true"/>}
    </section>;
  }
  return <OpenWorkspaceConversation.Provider value={openConversation}><OpenWorkspaceFile.Provider value={openFile}><div className="workbench workspace-conversation" tabIndex={-1} ref={root} aria-label={ja ? 'ワークスペース' : 'Workbench'} onKeyDownCapture={event => { if (handler(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); } }}>
    {tree ? renderTree(tree) : <div className="empty-state"><button className="btn btn-secondary" onClick={() => { setTree(createWorkspace(conversationId)); setFocused('initial-pane'); }}>{ja ? '会話を開く' : 'Open conversation'}</button><button className="btn btn-ghost" onClick={() => setPicker({ pane: id() })}>{ja ? 'ファイルを開く' : 'Open file'}</button></div>}
    {panes.flatMap(node => node.tabs.map(tab => createPortal(<VisibleView mountHidden visible={tab.id === node.active}><div className="workbench-content" style={{ display: 'contents' }} onFocusCapture={event => focusPane(node.id, event.target)} onPointerDownCapture={event => focusPane(node.id, event.target)}>{tab.kind === 'conversation' ? <WorkspaceConversationHeader.Provider value={{ tabId: tab.id, report: reportConversation }}><OpenWorkspaceTerminal.Provider value={terminalId => openTerminal(terminalId, node.id)}>{renderConversation(tab.conversationId, conversationId => replaceConversation(node.id, tab.id, conversationId))}</OpenWorkspaceTerminal.Provider></WorkspaceConversationHeader.Provider> : tab.kind === 'code' ? <FeatureErrorBoundary><Suspense fallback={<LoadingFeature language={language}/>}><CodeTab path={tab.path} document={getDocument(tab)} language={language}/></Suspense></FeatureErrorBoundary> : <TerminalTab key={`${tab.id}:${restart}`} session={getTerminal(tab)} language={language} reopen={() => { terminals.current.get(tab.id)?.dispose(); terminals.current.delete(tab.id); setRestart(value => value + 1); }}/>}</div></VisibleView>, getBody(tab.id), tab.id)))}
    {tabDrag.dragging && tabDrag.point && <div className="workbench-drag-ghost" data-valid={!!tabDrag.preview} aria-hidden="true" style={{ left: tabDrag.point.x + 12, top: tabDrag.point.y + 12 }}>{displayLabel(panes.flatMap(pane => pane.tabs).find(tab => tab.id === tabDrag.dragging)!)}</div>}
    {renameError && <p role="alert">{renameError}</p>}
    {picker && <FilePicker projectId={project} worktree={picker.worktree} client={client} language={language} close={() => { setPicker(undefined); root.current?.focus(); }} open={path => openFile(path, picker.worktree, picker.pane)}/>}
  </div></OpenWorkspaceFile.Provider></OpenWorkspaceConversation.Provider>;
}
