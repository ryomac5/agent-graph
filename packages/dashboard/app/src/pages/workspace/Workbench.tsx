import { ResizeDivider } from '../../components/ResizeDivider.tsx';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { type CodeDocument } from '../../lib/code-document.ts';
import { getFileDocument } from '../../lib/file-documents.ts';
import { DEFAULT_KEYS, createKeyHandler, type KeyBindings } from '../../lib/keys.ts';
import { closeTab, createWorkspace, listPanes, moveTab, resizeSplit, restoreWorkspace, splitPane, updatePane, workspaceKey, type PaneTree, type WorkspaceTab } from '../../lib/panes.ts';
import { OpenWorkspaceFile, OpenWorkspaceTerminal } from '../../lib/workspace-context.ts';
import type { Language } from '../../lib/i18n.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { CodeTab } from './CodeTab.tsx';
import { TerminalTab, createTerminalSession, type TerminalSession } from './TerminalTab.tsx';
import { FilePicker } from './FilePicker.tsx';
import './workbench.css';
const id = () => crypto.randomUUID();
function fileKey(tab: Extract<WorkspaceTab, { kind: 'code' }>) { return JSON.stringify([tab.worktree ?? '', tab.path]); }
function CodeLabel({ document, name, language }: { document: CodeDocument; name: string; language: Language }) {
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  return <>{name}{state.dirty && <span aria-label={language === 'ja' ? '未保存' : 'Unsaved'}> ●</span>}{state.external && <span aria-label={language === 'ja' ? '外で変更' : 'Changed on disk'}> !</span>}</>;
}
export function Workbench({ project, session, conversationId, client, language, bindings = DEFAULT_KEYS, renderConversation, registerOpenFile, newSession }: {
  project: string; session: string; conversationId: string; client: ConversationClient; language: Language; bindings?: KeyBindings;
  newSession?: string; renderConversation: (conversationId: string, onConversation: (id: string) => void) => ReactNode; registerOpenFile?: RefObject<(path: string, worktree?: string) => void>;
}) {
  const key = workspaceKey(project, session);
  const [tree, setTree] = useState<PaneTree | null>(() => {
    const saved = localStorage.getItem(key);
    if (!saved && newSession && !conversationId) return { kind: 'pane', id: 'initial-pane', tabs: [{ kind: 'conversation', id: newSession, conversationId: '' }], active: newSession };
    return restoreWorkspace(saved, conversationId);
  });
  const [focused, setFocused] = useState(() => tree ? listPanes(tree)[0].id : '');
  const [menu, setMenu] = useState<string>(), [picker, setPicker] = useState<{ pane: string; worktree?: string }>();
  const [renaming, setRenaming] = useState<{ pane: string; tab: string; value: string }>();
  const [tabMenu, setTabMenu] = useState<{ pane: string; tab: WorkspaceTab }>();
  const openedSession = useRef<string | undefined>(undefined);
  const [restart, setRestart] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const documents = useRef(new Map<string, CodeDocument>());
  const terminals = useRef(new Map<string, TerminalSession>());
  const dragTab = useRef<string | undefined>(undefined);
  const ja = language === 'ja';
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
  function label(tab: WorkspaceTab) { return tab.name || (tab.kind === 'code' ? tab.path.split('/').at(-1)! : tab.kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : tab.conversationId ? ja ? '会話' : 'Conversation' : ja ? '新しいセッション' : 'New session'); }
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
  const openFile = useCallback((path: string, worktree?: string) => {
    const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'code' && tab.path === path && (tab.worktree ?? '') === (worktree ?? ''));
    if (existing) { setFocused(existing.pane.id); setTree(tree => tree && updatePane(tree, existing.pane.id, pane => ({ ...pane, active: existing.tab.id }))); requestAnimationFrame(() => root.current?.focus()); return; }
    const tab: WorkspaceTab = { kind: 'code', id: id(), path, ...(worktree ? { worktree } : {}) };
    if (focusedPane) { setTree(tree => tree && updatePane(tree, focusedPane.id, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id }))); setFocused(focusedPane.id); }
    else { const paneId = id(); setTree({ kind: 'pane', id: paneId, tabs: [tab], active: tab.id }); setFocused(paneId); }
    requestAnimationFrame(() => root.current?.focus());
  }, [tree, focused]);
  useEffect(() => { if (registerOpenFile) registerOpenFile.current = openFile; }, [registerOpenFile, openFile]);
  function addTab(kind: 'conversation' | 'terminal', paneId: string) {
    const tab: WorkspaceTab = kind === 'conversation' ? { kind, id: id(), conversationId } : { kind, id: id(), ...(activeTab && 'worktree' in activeTab && activeTab.worktree ? { worktree: activeTab.worktree } : {}) };
    setTree(tree => tree ? updatePane(tree, paneId, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })) : { kind: 'pane', id: paneId, tabs: [tab], active: tab.id }); setFocused(paneId); setMenu(undefined);
  }
  function openTerminal(terminalId: string, sourcePane: string) {
    const existing = panes.flatMap(pane => pane.tabs.map(tab => ({ pane, tab }))).find(({ tab }) => tab.kind === 'terminal' && tab.terminalId === terminalId);
    if (existing) { setFocused(existing.pane.id); setTree(tree => tree && updatePane(tree, existing.pane.id, pane => ({ ...pane, active: existing.tab.id }))); return; }
    const tab: WorkspaceTab = { kind: 'terminal', id: id(), terminalId };
    const neighbor = panes.find(pane => pane.id !== sourcePane);
    const paneId = neighbor?.id ?? id();
    setTree(tree => tree && (neighbor ? updatePane(tree, paneId, pane => ({ ...pane, tabs: [...pane.tabs, tab], active: tab.id })) : splitPane(tree, sourcePane, 'horizontal', tab, paneId, id())));
    setFocused(paneId);
  }
  function split(direction: 'horizontal' | 'vertical') {
    if (!focusedPane || !activeTab) return;
    const paneId = id(); const tab = { ...activeTab, id: id() };
    setTree(tree => tree && splitPane(tree, focusedPane.id, direction, tab, paneId, id())); setFocused(paneId);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] [role="tab"][aria-selected="true"]`)?.focus());
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
  function renderTree(node: PaneTree): ReactNode {
    if (node.kind === 'split') return <div className={`workbench-split ${node.direction}`} key={node.id}>
      <div className="split-child" style={{ flexGrow: node.ratio }}>{renderTree(node.first)}</div>
      <ResizeDivider label={ja ? '区画の大きさ' : 'Pane size'} orientation={node.direction === 'horizontal' ? 'vertical' : 'horizontal'} value={Math.round(node.ratio * 100)} min={10} max={90}
        onChange={value => setTree(tree => tree && resizeSplit(tree, node.id, value / 100))}
        onReset={() => setTree(tree => tree && resizeSplit(tree, node.id, 0.5))}
        onDrag={(delta, bounds) => { const size = (node.direction === 'horizontal' ? bounds.width : bounds.height) - 6; if (size > 0) setTree(tree => tree && resizeSplit(tree, node.id, node.ratio + delta / size)); }}
        /><div className="split-child" style={{ flexGrow: 1 - node.ratio }}>{renderTree(node.second)}</div></div>;
    return <section className="workbench-pane" key={node.id} data-pane-id={node.id} data-focused={focusedPane?.id === node.id} onFocusCapture={() => setFocused(node.id)} onPointerDownCapture={() => setFocused(node.id)}>
      <header className="workbench-tabs" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const tabId = event.dataTransfer.getData('text/plain') || dragTab.current; if (tabId) { setTree(tree => tree && moveTab(tree, tabId, node.id)); setFocused(node.id); } dragTab.current = undefined; }}>
        <div className="workbench-tablist" role="tablist" aria-label={ja ? '作業場のタブ' : 'Workspace tabs'}>{node.tabs.map(tab => <div className="workbench-tab" key={tab.id} draggable onDragStart={event => { dragTab.current = tab.id; event.dataTransfer.setData('text/plain', tab.id); }} onDragEnd={() => { dragTab.current = undefined; }}
          onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); const tabId = event.dataTransfer.getData('text/plain') || dragTab.current; if (tabId) { setTree(tree => tree && moveTab(tree, tabId, node.id, tab.id)); setFocused(node.id); } dragTab.current = undefined; }}
          onContextMenu={event => { event.preventDefault(); setTabMenu({ pane: node.id, tab }); }}
          onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tab); } }}>
          {renaming?.tab === tab.id ? <input className="input-sm" autoFocus aria-label={ja ? 'タブの名前' : 'Tab name'} value={renaming.value} onFocus={event => event.currentTarget.select()} onChange={event => setRenaming({ ...renaming, value: event.target.value })} onBlur={finishRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishRename(); } else if (event.key === 'Escape') { event.preventDefault(); setRenaming(undefined); } }}/>
          : <button onDoubleClick={() => beginRename(node.id, tab)} role="tab" id={`workspace-tab-${tab.id}`} aria-controls={`workspace-body-${tab.id}`} aria-selected={tab.id === node.active} title={tab.kind === 'code' ? tab.path : undefined} onClick={() => { setFocused(node.id); setTree(tree => tree && updatePane(tree, node.id, pane => ({ ...pane, active: tab.id }))); }}>{tab.kind === 'code' ? <CodeLabel document={getDocument(tab)} language={language} name={label(tab)}/> : label(tab)}</button>}
          <button className="icon-button" aria-label={`${ja ? '閉じる' : 'Close'} ${tab.kind === 'code' ? tab.path : tab.kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? '会話' : 'Conversation'}`} onClick={() => close(tab)}>×</button>
        </div>)}</div>
        <div className="workbench-add"><button className="icon-button" aria-label={ja ? 'タブを開く' : 'Open tab'} aria-expanded={menu === node.id} onClick={() => setMenu(menu === node.id ? undefined : node.id)}>+</button>
          {menu === node.id && <div className="workbench-menu" role="menu">{(['conversation', 'terminal', 'file'] as const).map(kind => <button className="btn btn-ghost" role="menuitem" key={kind} onClick={() => { if (kind === 'file') { setPicker({ pane: node.id, worktree: activeTab && 'worktree' in activeTab ? activeTab.worktree : undefined }); setMenu(undefined); } else addTab(kind, node.id); }}>{kind === 'conversation' ? ja ? '会話' : 'Conversation' : kind === 'terminal' ? ja ? 'ターミナル' : 'Terminal' : ja ? 'ファイルを開く' : 'Open file'}</button>)}</div>}</div>
        {tabMenu?.pane === node.id && <div className="workbench-menu" role="menu"><button className="btn btn-ghost" role="menuitem" onClick={() => beginRename(node.id, tabMenu.tab)}>{ja ? '名前を変える' : 'Rename'}</button><button className="btn btn-ghost" role="menuitem" onClick={() => setTabMenu(undefined)}>{ja ? '閉じる' : 'Close'}</button></div>}
      </header>
      {node.tabs.map(tab => <div key={tab.id} role="tabpanel" id={`workspace-body-${tab.id}`} aria-labelledby={`workspace-tab-${tab.id}`} hidden={tab.id !== node.active} className="workbench-body">
        {tab.kind === 'conversation' ? <OpenWorkspaceTerminal.Provider value={terminalId => openTerminal(terminalId, node.id)}>{renderConversation(tab.conversationId, conversationId => replaceConversation(node.id, tab.id, conversationId))}</OpenWorkspaceTerminal.Provider> : tab.kind === 'code' ? <CodeTab path={tab.path} document={getDocument(tab)} language={language}/> : <TerminalTab key={`${tab.id}:${restart}`} session={getTerminal(tab)} language={language} reopen={() => { terminals.current.get(tab.id)?.dispose(); terminals.current.delete(tab.id); setRestart(value => value + 1); }}/>}</div>)}
    </section>;
  }
  return <OpenWorkspaceFile.Provider value={openFile}><div className="workbench workspace-conversation" tabIndex={-1} ref={root} aria-label={ja ? '作業場' : 'Workbench'} onKeyDownCapture={event => { if (handler(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); } }}>
    {tree ? renderTree(tree) : <div className="empty-state"><button className="btn btn-secondary" onClick={() => { setTree(createWorkspace(conversationId)); setFocused('initial-pane'); }}>{ja ? '会話を開く' : 'Open conversation'}</button><button className="btn btn-ghost" onClick={() => setPicker({ pane: id() })}>{ja ? 'ファイルを開く' : 'Open file'}</button></div>}
    {picker && <FilePicker projectId={project} worktree={picker.worktree} client={client} language={language} close={() => { setPicker(undefined); root.current?.focus(); }} open={path => openFile(path, picker.worktree)}/>}
  </div></OpenWorkspaceFile.Provider>;
}
