import { FeatureErrorBoundary } from '../../components/FeatureErrorBoundary.tsx';
import { StatusDot } from '../../components/StateBadge.tsx';
import { Icon } from '../../components/Icon.tsx';
import { ResizeDivider } from '../../components/ResizeDivider.tsx';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { type CodeDocument } from '../../lib/code-document.ts';
import { getFileDocument } from '../../lib/file-documents.ts';
import { DEFAULT_KEYS, createKeyHandler, type KeyBindings } from '../../lib/keys.ts';
import { closePane, closeTab, createWorkspace, listPanes, moveTab, resizeSplit, restoreWorkspace, splitAndMoveTab, splitPane, updatePane, workspaceKey, type PaneTree, type WorkspaceTab } from '../../lib/panes.ts';
import { OpenWorkspaceConversation, OpenWorkspaceFile, OpenWorkspaceTerminal, WorkspaceConversationHeader, type ConversationTabMetadata } from '../../lib/workspace-context.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { useTabDrag } from './useTabDrag.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { LoadingFeature } from '../../components/LoadingFeature.tsx';
import { TerminalTab, createTerminalSession, type TerminalSession } from './TerminalTab.tsx';
import { FilePicker } from './FilePicker.tsx';
import './workbench.css';
const CodeTab = lazy(() => import('./CodeTab.tsx').then(module => ({ default: module.CodeTab })));
const WHEEL_LINE_HEIGHT = 16;
const id = () => crypto.randomUUID();
function fileKey(tab: Extract<WorkspaceTab, { kind: 'code' }>) { return JSON.stringify([tab.worktree ?? '', tab.path]); }
function CodeLabel({ document, name, language }: { document: CodeDocument; name: string; language: Language }) {
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  return <>{name}{state.dirty && <span aria-label={language === 'ja' ? '未保存' : 'Unsaved'}> ●</span>}{state.external && <span aria-label={language === 'ja' ? '外で変更' : 'Changed on disk'}> !</span>}</>;
}
export function Workbench({ project, session, conversationId, client, language, bindings = DEFAULT_KEYS, renderConversation, registerOpenFile, newSession, openConversationId }: {
  project: string; session: string; conversationId: string; client: ConversationClient; language: Language; bindings?: KeyBindings;
  openConversationId?: string; newSession?: string; renderConversation: (conversationId: string, onConversation: (id: string) => void) => ReactNode; registerOpenFile?: RefObject<(path: string, worktree?: string) => void>;
}) {
  const [conversationTabs, setConversationTabs] = useState<Record<string, ConversationTabMetadata>>({});
  const reportConversation = useCallback((tabId: string, metadata: ConversationTabMetadata) => {
    setConversationTabs(previous => {
      const current = previous[tabId];
      return current?.name === metadata.name && current.state === metadata.state && current.title === metadata.title && current.autoName === metadata.autoName && current.startedAt === metadata.startedAt ? previous : { ...previous, [tabId]: metadata };
    });
  }, []);
  const key = workspaceKey(project, session);
  const [tree, setTree] = useState<PaneTree | null>(() => {
    const saved = localStorage.getItem(key);
    if (!saved && newSession && !conversationId) return { kind: 'pane', id: 'initial-pane', tabs: [{ kind: 'conversation', id: newSession, conversationId: '' }], active: newSession };
    return restoreWorkspace(saved, conversationId);
  });
  const [focused, setFocused] = useState(() => tree ? listPanes(tree)[0].id : '');
  const [menu, setMenu] = useState<string>(), [picker, setPicker] = useState<{ pane: string; worktree?: string }>();
  const [renaming, setRenaming] = useState<{ pane: string; tab: string; value: string }>();
  const [tabMenu, setTabMenu] = useState<{ pane: string; tab: WorkspaceTab; x: number; y: number }>();
  const openedSession = useRef<string | undefined>(undefined);
  const [restart, setRestart] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const documents = useRef(new Map<string, CodeDocument>());
  const terminals = useRef(new Map<string, TerminalSession>());
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
    if (!openConversationId) return;
    setTree(current => {
      if (!current) return createWorkspace(openConversationId);
      const existing = listPanes(current).flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'conversation' && tab.conversationId === openConversationId);
      if (existing) { setFocused(existing.pane.id); return updatePane(current, existing.pane.id, pane => ({ ...pane, active: existing.tab.id })); }
      const pane = listPanes(current).find(pane => pane.id === focused) ?? listPanes(current)[0];
      const tab: WorkspaceTab = { kind: 'conversation', id: id(), conversationId: openConversationId };
      setFocused(pane.id);
      return updatePane(current, pane.id, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id }));
    });
  }, [openConversationId]);
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
  function beginRename(pane: string, tab: WorkspaceTab) { setRenaming({ pane, tab: tab.id, value: label(tab) }); setTabMenu(undefined); }
  function finishRename() {
    if (!renaming) return;
    const { pane, tab, value } = renaming;
    setTree(current => current && updatePane(current, pane, node => ({ ...node, tabs: node.tabs.map(item => item.id === tab ? { ...item, name: value.trim() || undefined } : item) })));
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
  useEffect(() => { localStorage.setItem(key, JSON.stringify(tree)); }, [key, tree]);
  useEffect(() => {
    const live = new Set(panes.flatMap(pane => pane.tabs).map(tab => tab.id));
    for (const [tabId, terminal] of terminals.current) if (!live.has(tabId)) { terminal.dispose(); terminals.current.delete(tabId); }
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
  function openConversation(conversationId: string): boolean {
    if (!focusedPane || focusedPane.tabs.length) return false;
    const tab: WorkspaceTab = { kind: 'conversation', id: id(), conversationId };
    setTree(tree => tree && updatePane(tree, focusedPane.id, pane => ({ ...pane, tabs: [tab], active: tab.id })));
    return true;
  }
  function focusPane(paneId: string, target: EventTarget) {
    if (focusedPane?.tabs.length === 0 && target instanceof Element && target.closest('.delegation-card')) return;
    setFocused(paneId);
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
        {node.tabs.filter(tab => tab.kind === 'conversation').map(tab => <div key={tab.id} id={`workspace-back-${tab.id}`} className="workbench-back" hidden={tab.id !== node.active}/>)}
        <div className="workbench-tablist" role="tablist" aria-label={ja ? 'ワークスペースのタブ' : 'Workspace tabs'}>{node.tabs.map(tab => <div className="workbench-tab" key={tab.id} data-tab-id={tab.id} data-dragging={tabDrag.dragging === tab.id} data-drop-before={tabDrag.preview?.pane === node.id && tabDrag.preview?.tablist && tabDrag.preview.before === tab.id} onPointerDown={event => { setTabMenu(undefined); if (event.button === 1) event.preventDefault(); tabDrag.begin(event, tab.id); }} onClickCapture={event => { if (tabDrag.suppressClick.current) { tabDrag.suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } }}
          onContextMenu={event => { event.preventDefault(); if (tabDrag.active.current) return; const bounds = event.currentTarget.getBoundingClientRect(); setTabMenu({ pane: node.id, tab, x: event.clientX || bounds.left, y: event.clientY || bounds.bottom }); }}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab); } }}>
          {renaming?.tab === tab.id ? <input className="input-sm" autoFocus aria-label={ja ? 'タブの名前' : 'Tab name'} value={renaming.value} onFocus={event => event.currentTarget.select()} onChange={event => setRenaming({ ...renaming, value: event.target.value })} onBlur={finishRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishRename(); } else if (event.key === 'Escape') { event.preventDefault(); setRenaming(undefined); } }}/>
          : <button onDoubleClick={() => beginRename(node.id, tab)} role="tab" id={`workspace-tab-${tab.id}`} aria-label={tab.kind === 'conversation' ? displayLabel(tab) : undefined} aria-controls={`workspace-body-${tab.id}`} aria-selected={tab.id === node.active} title={tab.kind === 'code' ? tab.path : tab.kind === 'conversation' ? displayLabel(tab) + (conversationTabs[tab.id]?.title ? ' · ' + conversationTabs[tab.id].title : '') : undefined} onClick={() => { setFocused(node.id); setTree(tree => tree && updatePane(tree, node.id, pane => ({ ...pane, active: tab.id }))); }}>{tab.kind === 'conversation' && conversationTabs[tab.id] && <StatusDot state={conversationTabs[tab.id].state} language={language} dotOnly activity/>}<span className="truncate">{tab.kind === 'code' ? <CodeLabel document={getDocument(tab)} language={language} name={label(tab)}/> : label(tab)}</span>{tab.kind === 'conversation' && displayLabel(tab) !== label(tab) && <span className="workbench-tab-suffix">{displayLabel(tab).slice(label(tab).length)}</span>}</button>}
          <button className="icon-button" aria-label={`${ja ? '閉じる' : 'Close'} ${tab.kind === 'code' ? tab.path : tab.kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? '会話' : 'Conversation'}`} onClick={() => close(tab)}>×</button>
        </div>)}</div>
        {tabDrag.preview?.pane === node.id && tabDrag.preview.tablist && <span className="workbench-drop-end" style={{ left: tabDrag.preview.line }}/>}
        <div className="workbench-add"><button className="icon-button" aria-label={ja ? 'タブを開く' : 'Open tab'} aria-expanded={menu === node.id} onClick={() => setMenu(menu === node.id ? undefined : node.id)}>+</button>
          {menu === node.id && <div className="workbench-menu" role="menu" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('button')?.focus(); } }}>{(['conversation', 'terminal', 'file'] as const).map(kind => <button className="btn btn-ghost" role="menuitem" key={kind} onClick={() => { if (kind === 'file') { setPicker({ pane: node.id, worktree: activeTab && 'worktree' in activeTab ? activeTab.worktree : undefined }); setMenu(undefined); } else addTab(kind, node.id); }}>{kind === 'conversation' ? ja ? '会話' : 'Conversation' : kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? 'ファイルを開く' : 'Open file'}</button>)}</div>}</div>
        {node.tabs.filter(tab => tab.kind === 'conversation').map(tab => <div key={tab.id} id={`workspace-actions-${tab.id}`} className="workbench-actions" hidden={tab.id !== node.active}/>)}
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
      {node.tabs.map(tab => <div key={tab.id} role="tabpanel" id={`workspace-body-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={tab.id !== node.active} className="workbench-body">
        {tab.kind === 'conversation' ? <WorkspaceConversationHeader.Provider value={{ tabId: tab.id, report: reportConversation }}><OpenWorkspaceTerminal.Provider value={terminalId => openTerminal(terminalId, node.id)}>{renderConversation(tab.conversationId, conversationId => replaceConversation(node.id, tab.id, conversationId))}</OpenWorkspaceTerminal.Provider></WorkspaceConversationHeader.Provider> : tab.kind === 'code' ? <FeatureErrorBoundary><Suspense fallback={<LoadingFeature language={language}/>}><CodeTab path={tab.path} document={getDocument(tab)} language={language}/></Suspense></FeatureErrorBoundary> : <TerminalTab key={`${tab.id}:${restart}`} session={getTerminal(tab)} language={language} reopen={() => { terminals.current.get(tab.id)?.dispose(); terminals.current.delete(tab.id); setRestart(value => value + 1); }}/>}</div>)}
      {tabDrag.preview?.pane === node.id && !tabDrag.preview.tablist && <div className={`workbench-drop-preview ${tabDrag.preview.edge ?? 'center'}`} aria-hidden="true"/>}
    </section>;
  }
  return <OpenWorkspaceConversation.Provider value={openConversation}><OpenWorkspaceFile.Provider value={openFile}><div className="workbench workspace-conversation" tabIndex={-1} ref={root} aria-label={ja ? 'ワークスペース' : 'Workbench'} onKeyDownCapture={event => { if (handler(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); } }}>
    {tree ? renderTree(tree) : <div className="empty-state"><button className="btn btn-secondary" onClick={() => { setTree(createWorkspace(conversationId)); setFocused('initial-pane'); }}>{ja ? '会話を開く' : 'Open conversation'}</button><button className="btn btn-ghost" onClick={() => setPicker({ pane: id() })}>{ja ? 'ファイルを開く' : 'Open file'}</button></div>}
    {tabDrag.dragging && tabDrag.point && <div className="workbench-drag-ghost" data-valid={!!tabDrag.preview} aria-hidden="true" style={{ left: tabDrag.point.x + 12, top: tabDrag.point.y + 12 }}>{displayLabel(panes.flatMap(pane => pane.tabs).find(tab => tab.id === tabDrag.dragging)!)}</div>}
    {picker && <FilePicker projectId={project} worktree={picker.worktree} client={client} language={language} close={() => { setPicker(undefined); root.current?.focus(); }} open={path => openFile(path, picker.worktree, picker.pane)}/>}
  </div></OpenWorkspaceFile.Provider></OpenWorkspaceConversation.Provider>;
}
