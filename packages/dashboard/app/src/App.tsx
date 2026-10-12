import { FeatureErrorBoundary } from './components/FeatureErrorBoundary.tsx';
import { SessionCreate } from './components/SessionCreate.tsx';
import { dismissEscapeLayer } from './lib/escape-layers.ts';
import { LoadingFeature } from './components/LoadingFeature.tsx';
import { ResizeDivider } from './components/ResizeDivider.tsx';
import { SIDEBAR_WIDTH_KEY, SIDEBAR_COLLAPSED_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_INITIAL_WIDTH, SIDEBAR_COMPACT_WIDTH, SIDEBAR_RESTORE_WIDTH, clampSidebar, useStoredToggle } from './lib/layout.ts';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createKeyHandler, isTextInput, keyLabel, type KeyAction } from './lib/keys.ts';
import { CommandDialog, CommandPalette, useKeySettings, type Command } from './components/command/Commands.tsx';
import { ProjectAdd } from './components/ProjectAdd.tsx';
import { request, startSession, readSessionProvider } from './lib/session-start.ts';
import './components/command/command.css';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { dictionaries, type Language, type TextKey } from './lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from './lib/store.ts';
import type { ConversationClient } from './pages/conversation/ConversationPage.tsx';
import { HomePage } from './pages/home/HomePage.tsx';
import { FileNotices, FileTreePanel, FileViewerPanel, useFileExplorer } from './pages/files/FilesPage.tsx';
import { WorkspacePage } from './pages/workspace/WorkspacePage.tsx';
import { AssignedGraphPage } from './pages/graph/GraphPage.tsx';
import { ChangesPage } from './pages/changes/ChangesPage.tsx';
import { SearchPage } from './pages/search/SearchPage.tsx';
import { createSearchClient, type SearchClient } from './pages/search/model.ts';
import { Inbox } from './pages/inbox/Inbox.tsx';
import { answerApproval, getDecision, getInbox } from './pages/inbox/model.ts';
import { TurnSignals } from './components/TurnSignals.tsx';
import { Notifications } from './components/notifications/Notifications.tsx';
import { selectRoots, isRunning, rootProject, buildRootTree, useRootIndex } from './lib/roots.ts';
import { ProjectList } from './components/ProjectList.tsx';
import { RootList } from './components/RootViews.tsx';
import { Icon } from './components/Icon.tsx';
import { UsageBar } from './components/usage/UsageBar.tsx';
import { fetchProjection } from './lib/projection-client.ts';
import type { Row } from './lib/store.ts';
import { getRegisteredProjects, OTHER_PROJECT, resolveProjectId } from './lib/projects.ts';
import './styles.css';

const SettingsPage = lazy(() => import('./pages/settings/SettingsPage.tsx').then(module => ({ default: module.SettingsPage })));
const SettingsLayout = lazy(() => import('./pages/settings/SettingsLayout.tsx').then(module => ({ default: module.SettingsLayout })));

export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(theme: Theme, dark: boolean) {
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}
function EmptyView({ title, future, t }: { title: TextKey; future?: boolean; t: (key: TextKey) => string }) {
  const params = useParams();
  return <div className="page"><header className="page-header"><h1>{t(title)}</h1></header>
    {params.project && <nav className="tabs" aria-label={t('project')}><NavLink end to={`/p/${encodeURIComponent(params.project)}`}>{t('conversations')}</NavLink><NavLink to={`/p/${encodeURIComponent(params.project)}/changes`}>{t('changes')}</NavLink></nav>}
    <div className="empty-state"><Icon name={future ? 'sparkle' : 'search'} size={22}/>
    <h2>{t(future ? 'futureTitle' : 'emptyTitle')}</h2></div></div>;
}
/** 旧い図の経路でも根の選択を保つ。 */
function RequestsRedirect() {
  const params = useParams(); const location = useLocation();
  return <Navigate replace to={`/p/${encodeURIComponent(params.project ?? '')}/graph${location.search}`}/>;
}
const unavailableClient: ConversationClient = { command: async (_command, _payload, cmdId = '') => ({ type: 'ack', cmd_id: cmdId, ok: false, error: 'Runner unavailable' }) };
const defaultSearchClient: SearchClient = { search: (query, signal) => createSearchClient({
  token: document.querySelector<HTMLMetaElement>('meta[name="agent-graph-token"]')?.content ?? '',
}).search(query, signal) };
export function App({ target = store, client = unavailableClient, searchClient = defaultSearchClient }: { target?: ScreenStore; client?: ConversationClient; searchClient?: SearchClient }) {
  const navigate = useNavigate();
  const state = useScreenStore(target);
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('agent-graph-language') === 'ja' ? 'ja' : 'en');
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('agent-graph-theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  });
  const t = (key: TextKey) => dictionaries[language][key];
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme, media.matches);
    update(); media.addEventListener('change', update);
    localStorage.setItem('agent-graph-theme', theme);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  useEffect(() => { document.documentElement.lang = language; localStorage.setItem('agent-graph-language', language); }, [language]);
  const projects = getRegisteredProjects(state).map(row => ({ id: String(row.id), name: String(row.display_name), full: String(row.display_name), detail: '' }));
  const roots = useMemo(() => selectRoots(state), [state]);
  const rootIndex = useRootIndex(state);
  const registeredIds = new Set(projects.map(row => row.id));
  const hasOther = roots.some(row => rootProject(row, registeredIds) === OTHER_PROJECT);
  useEffect(() => {
    const controller = new AbortController();
    const projection: Record<string, Row[]> = {};
    const pages = { ...state.pages };
    void (async () => {
      for (const [table, page] of Object.entries(state.pages ?? {})) {
        pages[table] = { ...page, next: null };
        let after = page.next;
        while (after) {
          const next = await fetchProjection<{ rows: Row[]; next: string | null; generation: number }>(`/projection?table=${encodeURIComponent(table)}&after=${encodeURIComponent(after)}`, controller.signal);
          if (controller.signal.aborted || next.generation !== target.getSnapshot().generation) return;
          (projection[table] ??= []).push(...next.rows);
          if (next.next === after) throw new Error('Unable to advance activity list');
          after = next.next;
        }
      }
      if (Object.keys(projection).length) target.mergeProjection(projection, state.generation, undefined, pages);
    })().catch(error => {
      if (!controller.signal.aborted) target.mergeProjection(projection, state.generation, undefined, pages,
        `Unable to load the full activity list. ${error instanceof Error ? error.message : ''}`.trim());
    });
    return () => controller.abort();
  }, [state.pages, state.generation, target]);
  const approvals = getInbox(state).pending.length;
  const location = useLocation();
  const auxiliaryPage = ['/', '/settings', '/inbox', '/search'].includes(location.pathname);
  const previousUrl = useRef<string | undefined>(undefined);
  const [returnUrl, setReturnUrl] = useState<string>();
  const [lastWorkspace, setLastWorkspace] = useState(() => localStorage.getItem('agent-graph-last-workspace') ?? '');
  useEffect(() => {
    const url = location.pathname + location.search + location.hash;
    if (previousUrl.current !== url) {
      if (auxiliaryPage) setReturnUrl(previousUrl.current);
      previousUrl.current = url;
    }
    if (/^\/p\/[^/]+$/.test(location.pathname)) {
      localStorage.setItem('agent-graph-last-workspace', url); setLastWorkspace(url);
    }
  }, [location.pathname, location.search, location.hash, auxiliaryPage]);
  const { bindings, setBindings } = useKeySettings(client);
  const [creatingSession, setCreatingSession] = useState<string>();
  const [overlay, setOverlay] = useState<'commands' | 'help' | 'interrupt'>();
  const [addingProject, setAddingProject] = useState(false);
  const [revealedProject, setRevealedProject] = useState<string>();
  const [hasSsh, setHasSsh] = useState(false);
  const [startingProjects, setStartingProjects] = useState<Set<string>>(new Set());
  const launching = useRef(new Set<string>());
  const pendingTerminals = useRef(new Map<string, string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { let active = true; void request<{ connections?: unknown[] }>(client, 'ssh.read').then(result => { if (active) setHasSsh(Boolean(result?.connections?.length)); }, () => { if (active) setHasSsh(false); }); return () => { active = false; }; }, [client, location.pathname, overlay]);
  async function beginConversation(id: string) {
    if (launching.current.has(id)) return;
    launching.current.add(id); setStartingProjects(new Set(launching.current)); setCommandError('');
    try {
      const conversation = await startSession(client, { projectId: id, target: { kind: 'local' }, provider: readSessionProvider() }, {
        terminalId: pendingTerminals.current.get(id), onLaunched: terminal => pendingTerminals.current.set(id, terminal), active: () => mounted.current,
      });
      if (conversation && mounted.current) { pendingTerminals.current.delete(id); navigate('/p/' + encodeURIComponent(id) + '?conversation=' + encodeURIComponent(conversation)); setMobileView('conversation'); }
    } catch { if (mounted.current) setCommandError(language === 'ja' ? '会話を始められません' : 'Unable to start conversation'); }
    finally { launching.current.delete(id); if (mounted.current) setStartingProjects(new Set(launching.current)); }
  }
  const [stopButton, setStopButton] = useState<HTMLButtonElement>();
  const [commandError, setCommandError] = useState('');
  const answered = useRef(new Set<string>());
  const contextFocus = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pathProject = /^\/p\/([^/]+)/.exec(location.pathname)?.[1];
  const pathConversation = /^\/c\/([^/]+)/.exec(location.pathname)?.[1];

  const directRoot = pathConversation ? roots.find(root => root.conversation_ids.includes(decodeURIComponent(pathConversation)) || buildRootTree(root, rootIndex).nodes.some(node => node.conversationId === decodeURIComponent(pathConversation))) : undefined;
  // 経路のプロジェクトは表示名でも識別子でも受け、投影の projects の識別子に揃える。
  const lastProject = /^\/p\/([^/?#]+)/.exec(lastWorkspace)?.[1];
  const project = pathProject ? resolveProjectId(state, decodeURIComponent(pathProject)) : directRoot?.project || (lastProject ? resolveProjectId(state, decodeURIComponent(lastProject)) : projects[0]?.id);
  useEffect(() => {
    if (pathConversation && project) {
      const url = `/p/${encodeURIComponent(project)}`;
      localStorage.setItem('agent-graph-last-workspace', url); setLastWorkspace(url);
    }
  }, [pathConversation, project]);
  const goBack = () => navigate(returnUrl ?? (project ? `/p/${encodeURIComponent(project)}` : '/'));
  const backAction = <button className="btn btn-ghost" onClick={goBack}>{language === 'ja' ? '← 戻る' : '← Back'}</button>;
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useStoredToggle(SIDEBAR_COLLAPSED_KEY);
  const [compactScreen, setCompactScreen] = useState(() => window.innerWidth <= 899);
  useEffect(() => {
    const update = () => setCompactScreen(window.innerWidth <= 899);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const sidebarDefault = () => window.innerWidth >= 1280 ? SIDEBAR_INITIAL_WIDTH : SIDEBAR_COMPACT_WIDTH;
  const [sidebarWidth, setSidebarWidth] = useState(() => { const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)); return Number.isFinite(saved) && saved > 0 ? clampSidebar(saved) : sidebarDefault(); });
  useEffect(() => { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); }, [sidebarWidth]);
  const [mobileView, setMobileView] = useState('conversation');
  const [search] = useSearchParams();
  const rootQuery = search.get('root'); const childQuery = search.get('child');
  useEffect(() => { setMobileView('conversation'); }, [location.pathname, rootQuery, childQuery]);
  const explorer = useFileExplorer({ client, target, project: pathProject ? decodeURIComponent(pathProject) : project ?? '', enabled: location.pathname.endsWith('/files') });
  const selectedRoot = roots.find(root => root.id === search.get('root')) ?? directRoot ?? roots.find(root => rootProject(root, registeredIds) === project);
  function moveRow(direction: number) {
    const rows = [...(mainRef.current?.querySelectorAll<HTMLElement>('.activity-name, [data-approval-id], .delegation-select, .graph-card-link, [role="treeitem"][tabindex]') ?? [])];
    const current = rows.findIndex(row => row === document.activeElement || (row.closest('.activity-item, .activity-row, [data-approval-id]') ?? row).contains(document.activeElement));
    const row = rows[Math.max(0, Math.min(rows.length - 1, current < 0 ? (direction > 0 ? 0 : rows.length - 1) : current + direction))];
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest' });
    if (row instanceof HTMLButtonElement && (row.classList.contains('activity-name') || row.classList.contains('delegation-select'))) row.click();
  }
  function answer(action: 'allow' | 'deny') {
    const label = action === 'allow' ? 'Allow' : 'Deny';
    const bulk = [...(mainRef.current?.querySelectorAll<HTMLButtonElement>('.bulk-bar button') ?? [])].find(button => button.textContent === `${label} selected` && !button.disabled);
    const focused = contextFocus.current?.closest('[data-approval-id]') ?? document.activeElement?.closest('[data-approval-id]');
    const row = focused ?? mainRef.current?.querySelector('[data-approval-id]:not(.sent)');
    const button = bulk ?? [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? mainRef.current?.querySelectorAll<HTMLButtonElement>('.approval-actions button') ?? [])].find(button => button.textContent === label && !button.disabled);
    button?.click();
  }
  function executeKey(action: KeyAction) {
    if (action === 'toggleSidebar') setSidebarCollapsed(value => !value);
    else if (action === 'command' || action === 'help') { contextFocus.current = document.activeElement as HTMLElement; setOverlay(action === 'command' ? 'commands' : 'help'); }
    else if (action === 'next' || action === 'previous') moveRow(action === 'next' ? 1 : -1);
    else if (action === 'allow' || action === 'deny') answer(action);
    else if (action === 'interrupt') {
      const focused = contextFocus.current?.closest('.activity-item, .activity-row');
      const context = focused ?? mainRef.current?.querySelector('.workspace-conversation') ?? mainRef.current;
      const buttons = [...(context?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      const stop = buttons.find(button => !button.disabled && /^(Interrupt|Stop|中断|停止)$/.test(button.textContent?.trim() ?? ''));
      if (stop) { setStopButton(stop); setOverlay('interrupt'); }
    } else if (action === 'home') navigate('/');
    else if (action === 'inbox') navigate('/inbox');
    else if (project) navigate(`/p/${encodeURIComponent(project)}${action === 'workspace' ? '' : action === 'tree' ? '/graph' : `/${action}`}`);
  }
  const executeRef = useRef(executeKey);
  executeRef.current = executeKey;
  const handleKey = useMemo(() => createKeyHandler(Object.fromEntries(Object.entries(bindings).filter(([action]) => !['splitHorizontal', 'splitVertical', 'openFile', 'saveFile', 'togglePanel'].includes(action))), action => executeRef.current(action)), [bindings, location.pathname, overlay]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (dismissEscapeLayer(event)) return;
      if (event.key === 'Escape' && document.querySelector('[role="menu"], [role="dialog"]')) return;
      if (event.target instanceof Element) {
        const projectRow = event.target.closest('.sidebar-project-row');
        if (event.target.closest('.project-actions-menu, .workbench-menu')
          || projectRow && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)
          || projectRow && event.key === 'Escape' && projectRow.querySelector('.project-actions[aria-expanded="true"]')) return;
      }
      if (overlay || creatingSession !== undefined || addingProject || (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.matches('.explorer-filter input'))) return;
      if (auxiliaryPage && event.key === 'Escape' && !isTextInput(event.target)) { event.preventDefault(); event.stopPropagation(); goBack(); return; }
      contextFocus.current = event.target instanceof HTMLElement ? event.target : null;
      if (handleKey(event)) { event.preventDefault(); event.stopPropagation(); }
      else if (!isTextInput(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && ['a', 'd'].includes(event.key.toLowerCase())) event.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [handleKey, overlay, creatingSession, addingProject, auxiliaryPage, returnUrl, project]);
  const commands: Command[] = [
    ...(['home', 'workspace', 'inbox', 'tree', 'changes', 'help', 'interrupt', 'toggleSidebar'] as const).map(id => ({ id, name: keyLabel(id, language), run: () => executeKey(id), disabled: ['workspace', 'tree', 'changes'].includes(id) && !project })),
    { id: 'search', name: language === 'ja' ? '会話を検索' : 'Search conversations', run: () => navigate('/search') },
    { id: 'settings', name: language === 'ja' ? '設定を開く' : 'Open Settings', run: () => navigate('/settings') },
    ...(hasSsh ? [{ id: 'ssh-session', name: language === 'ja' ? 'SSH 先で会話を始める' : 'Start conversation over SSH', run: () => setCreatingSession(project ?? String(projects[0]?.id ?? '')) }] : []),
    ...roots.map(root => ({ id: `conversation-${root.id}`, name: language === 'ja' ? `会話を開く: ${root.name}` : `Open ${isRunning(root.state) ? 'active ' : ''}conversation: ${root.name}`, run: () => navigate(`/p/${encodeURIComponent(root.project ?? OTHER_PROJECT)}?root=${encodeURIComponent(root.id)}`) })),
    ...getInbox(state).pending.flatMap(row => (['allow', 'deny'] as const).map(action => ({
      id: `${action}-${row.id}`, name: language === 'ja' ? `${action === 'allow' ? '許可' : '拒否'}: ${row.id}` : `${action === 'allow' ? 'Allow' : 'Deny'} approval: ${row.id}`,
      disabled: state.connection !== 'connected' || !getDecision(row, action) || answered.current.has(String(row.id)),
      run: () => {
        const id = String(row.id);
        if (answered.current.has(id)) return;
        answered.current.add(id); setCommandError('');
        void answerApproval(client, row, action).catch(error => { answered.current.delete(id); setCommandError(error instanceof Error ? error.message : String(error)); });
      },
    }))),
    ...projects.map(row => ({ id: `workspace-${row.id}`, name: language === 'ja' ? `ワークスペースを開く: ${row.full}` : `Open workspace: ${row.full}`, run: () => navigate(`/p/${encodeURIComponent(row.id)}`) })),
  ];
  const fullHeight = /^\/(c|p)\/[^/]+(?:\/(files|graph|tree))?$/.test(location.pathname);
  const icons = { overview: 'overview', inbox: 'inbox', search: 'search' } as const;
  return <div className={`app-shell mobile-${mobileView}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`} style={{ gridTemplateColumns: `${sidebarCollapsed ? SIDEBAR_RESTORE_WIDTH : sidebarWidth}px minmax(0, 1fr)` }}><TurnSignals target={target} bindings={bindings}/><aside className="sidebar"><button className="sidebar-restore" aria-label={language === 'ja' ? 'サイドバーを開く' : 'Expand sidebar'} title={bindings.toggleSidebar} onClick={() => setSidebarCollapsed(false)}><Icon name="chevronRight" size={14}/></button><div className="sidebar-content"><div className="sidebar-brand-row"><Link className="brand" to="/"><span className="brand-mark"><Icon name="logo" size={16}/></span>{t('brand')}</Link><div className="sidebar-actions"><button className="icon-button" aria-label={t('commands')} title={`${t('commands')} (${bindings.command})`} onClick={() => { contextFocus.current = document.activeElement as HTMLElement; setOverlay('commands'); }}><Icon name="search" size={16}/></button>
      <button className="icon-button" aria-label={language === 'ja' ? 'サイドバーを畳む' : 'Collapse sidebar'} title={bindings.toggleSidebar} onClick={() => setSidebarCollapsed(true)}><Icon name="chevronLeft" size={16}/></button><Notifications target={target} client={client} initiallyOpen={false} compact language={language}/></div>
    </div>{state.connection !== 'connected' && <span className={`connection ${state.connection}`} role="status"><span className="connection-dot" aria-hidden="true"/>{t(state.connection)}</span>}
    <nav aria-label={t('workspace')} className="nav-group">
      {(['overview', 'inbox', 'search'] as const).map(key => <NavLink key={key} end to={key === 'overview' ? '/' : `/${key}`}><Icon name={icons[key]} size={16}/><span className="nav-label">{t(key)}</span>
        {key === 'inbox' && approvals > 0 && <span className="nav-count numeric" aria-hidden="true">{approvals}</span>}</NavLink>)}
    </nav><div className="projects"><p className="eyebrow">{t('projects')}<span className="numeric">{projects.length}</span><button className="icon-button" aria-label={language === 'ja' ? 'プロジェクトを追加' : 'Add project'} onClick={() => { setRevealedProject(undefined); setAddingProject(true); }}><Icon name="plus" size={14}/></button></p>
      {projects.length === 0 && <p className="muted-text sidebar-empty">{t('noProjects')}</p>}
      <ProjectList revealProject={revealedProject} language={language} projects={[...projects, ...(hasOther ? [{ id: OTHER_PROJECT, name: t('other'), full: t('other'), detail: '' }] : [])]} renderProject={(row, attributes, actions) => {
        const items = roots.filter(root => rootProject(root, registeredIds) === row.id);
        const open = !(collapsedProjects[row.id] ?? row.id !== project);
        const runningCount = items.filter(root => isRunning(root.state)).length;
        return <>
          <div className="sidebar-project-row" {...attributes}><button className="icon-button" aria-label={language === 'ja' ? row.name + ' のセッション' : 'Toggle sessions for ' + row.name} aria-expanded={open} onClick={() => setCollapsedProjects(value => ({ ...value, [row.id]: open }))}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={16}/></button>
            <NavLink to={`/p/${encodeURIComponent(row.id)}`} title={row.full}><Icon name="folder" size={16}/><span className="truncate">{row.name}</span></NavLink>
            {runningCount > 0 && <span className="numeric project-running" aria-label={language === 'ja' ? '実行中のセッション' : 'Running sessions'}>{runningCount}</span>}
            {row.id !== OTHER_PROJECT && <button className="icon-button project-create" aria-label={(language === 'ja' ? '会話を始める' : 'Start conversation') + ': ' + row.name} disabled={state.connection !== 'connected' || startingProjects.has(row.id)} aria-busy={startingProjects.has(row.id)} onClick={() => void beginConversation(row.id)}>{startingProjects.has(row.id) ? <span className="project-start-spinner"/> : <Icon name="plus" size={14}/>}</button>}{actions}</div>
          {open && <section className="sidebar-roots" aria-label={language === 'ja' ? row.name + ' のセッション' : row.name + ' sessions'}><RootList client={client} grouped state={state} roots={items} selected={selectedRoot?.id} language={language} onSelect={root => { const next = new URLSearchParams(search); next.set('root', root.id); next.delete('child'); next.delete('path'); next.delete('session'); next.delete('conversation'); navigate(`/p/${encodeURIComponent(row.id)}?${next}`); setMobileView('conversation'); }}/></section>}
        </>;
      }}/>
    </div><UsageBar client={client} language={language} visible={!sidebarCollapsed && (!compactScreen || mobileView === 'sessions')} connected={state.connection === 'connected' || state.connection === 'runner_unavailable'}/><NavLink className="settings-link" to="/settings"><Icon name="settings" size={16}/>{t('settings')}</NavLink></div><ResizeDivider className="sidebar-resize" label={language === 'ja' ? 'サイドバーの幅' : 'Sidebar width'} orientation="vertical" value={sidebarWidth} min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} step={20}
      onChange={value => setSidebarWidth(clampSidebar(value))} onDrag={delta => setSidebarWidth(clampSidebar(sidebarWidth + delta))} onReset={() => setSidebarWidth(sidebarDefault())}/></aside>
    <nav className="mobile-tabs" aria-label={language === 'ja' ? '画面' : 'Views'}>{(['sessions', 'conversation', 'panel'] as const).map(view => <button key={view} aria-pressed={mobileView === view} onClick={() => setMobileView(view)}>{language === 'ja' ? { sessions: 'セッション', conversation: '会話', panel: 'パネル' }[view] : { sessions: 'Sessions', conversation: 'Conversation', panel: 'Panel' }[view]}</button>)}</nav>
    <div className="main-column">{state.projectionError && <p role="alert" className="status-line danger list-error">{state.projectionError}</p>}<main ref={mainRef} className={fullHeight ? 'full-height' : undefined}><Routes>
      <Route path="/" element={<HomePage target={target} client={client} language={language} backAction={backAction}/>}/>
      <Route path="/p/:project" element={<WorkspacePage target={target} client={client} language={language} bindings={bindings} showRootList={false}/>}/>
      <Route path="/c/:conversation" element={<WorkspacePage project={project ?? OTHER_PROJECT} conversationId={pathConversation ? decodeURIComponent(pathConversation) : undefined} target={target} client={client} language={language} bindings={bindings} showRootList={false}/>}/>
      <Route path="/inbox" element={<Inbox target={target} client={client} language={language} backAction={backAction}/>}/>
      <Route path="/p/:project/tree" element={<RequestsRedirect/>}/>
      <Route path="/p/:project/graph" element={<AssignedGraphPage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/changes" element={<ChangesPage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/files" element={<div className="files-page"><FileTreePanel explorer={explorer} language={language}/><FileNotices explorer={explorer}/><FileViewerPanel explorer={explorer} actions={<button className="btn btn-ghost btn-xs" onClick={explorer.closeFile}><Icon name="chevronLeft" size={12}/>Back</button>}/></div>}/>
      <Route path="/search" element={<SearchPage target={target} client={searchClient} language={language} backAction={backAction}/>}/>
      <Route path="/settings" element={<div className="page settings-page"><header className="page-header">{backAction}<h1>{t('settings')}</h1></header><FeatureErrorBoundary><Suspense fallback={<LoadingFeature language={language}/>}><SettingsLayout client={client} projects={getRegisteredProjects(state)} language={language} theme={theme} onTheme={setTheme} onLanguage={setLanguage} bindings={bindings} onKeys={setBindings}><SettingsPage client={client} language={language} policyOnly/></SettingsLayout></Suspense></FeatureErrorBoundary></div>}/>
      <Route path="*" element={<EmptyView title="notFound" t={t}/>}/>
    </Routes>{commandError && <p role="alert" className="banner banner-danger">{commandError}</p>}</main></div>
    {addingProject && <ProjectAdd client={client} language={language} onClose={() => setAddingProject(false)} onAdded={id => { setAddingProject(false); setRevealedProject(id); setCollapsedProjects(value => ({ ...value, [id]: false })); navigate('/p/' + encodeURIComponent(id)); }}/> }
    {creatingSession !== undefined && <SessionCreate client={client} projects={getRegisteredProjects(state)} initialProject={creatingSession} language={language} onClose={() => setCreatingSession(undefined)} onCreated={(project, conversation) => { setCreatingSession(undefined); navigate(`/p/${encodeURIComponent(project)}?conversation=${encodeURIComponent(conversation)}`); setMobileView('conversation'); }}/>}
    {overlay === 'commands' && <CommandPalette language={language} commands={commands} onClose={() => setOverlay(undefined)}/>}
    {overlay === 'help' && <CommandDialog language={language} title={language === 'ja' ? 'キーボードショートカット' : 'Shortcuts'} onClose={() => setOverlay(undefined)}><dl>{Object.entries(bindings).map(([key, value]) => <div key={key}><dt>{keyLabel(key as KeyAction, language)}</dt><dd><kbd>{value}</kbd></dd></div>)}</dl></CommandDialog>}
    {overlay === 'interrupt' && <CommandDialog language={language} title={language === 'ja' ? '実行を中断しますか？' : 'Interrupt run?'} onClose={() => setOverlay(undefined)}><button className="btn btn-primary" onClick={() => { if (stopButton?.isConnected && !stopButton.disabled) stopButton.click(); setOverlay(undefined); }}>{language === 'ja' ? '中断' : 'Confirm interrupt'}</button><button className="btn btn-secondary" onClick={() => setOverlay(undefined)}>{language === 'ja' ? 'キャンセル' : 'Cancel'}</button></CommandDialog>}
    </div>;
}
export function Dashboard({ client, searchClient }: { client: ConversationClient; searchClient?: SearchClient }) { return <BrowserRouter><App client={client} searchClient={searchClient}/></BrowserRouter>; }
