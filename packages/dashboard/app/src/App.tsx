import { useEffect, useMemo, useRef, useState } from 'react';
import { createKeyHandler, isTextInput, KEY_LABELS, type KeyAction } from './lib/keys.ts';
import { CommandDialog, CommandPalette, KeyboardSettings, useKeySettings, type Command } from './components/command/Commands.tsx';
import { CreateTaskForm } from './components/CreateTaskForm.tsx';
import './components/command/command.css';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { dictionaries, type Language, type TextKey } from './lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from './lib/store.ts';
import type { ConversationClient } from './pages/conversation/ConversationPage.tsx';
import { ConversationPage } from './pages/conversation/ConversationPage.tsx';
import { HomePage } from './pages/home/HomePage.tsx';
import { FileNotices, FileTreePanel, FileViewerPanel, useFileExplorer } from './pages/files/FilesPage.tsx';
import { WorkspacePage } from './pages/workspace/WorkspacePage.tsx';
import { ChangesPage } from './pages/changes/ChangesPage.tsx';
import { SearchPage } from './pages/search/SearchPage.tsx';
import { createSearchClient, type SearchClient } from './pages/search/model.ts';
import { Inbox } from './pages/inbox/Inbox.tsx';
import { answerApproval, getDecision, getInbox } from './pages/inbox/model.ts';
import { Notifications } from './components/notifications/Notifications.tsx';
import { selectRoots, isRunning } from './lib/roots.ts';
import { Icon } from './components/Icon.tsx';
import { fetchProjection } from './lib/projection-client.ts';
import type { Row } from './lib/store.ts';
import { getRegisteredProjects, OTHER_PROJECT, resolveProjectId } from './lib/projects.ts';
import './styles.css';

const FILES_COLLAPSE_WIDTH = 1024;
export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(theme: Theme, dark: boolean) {
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}
function EmptyView({ title, future, t }: { title: TextKey; future?: boolean; t: (key: TextKey) => string }) {
  const params = useParams();
  return <div className="page"><header className="page-header"><h1>{t(title)}</h1></header>
    {params.project && <nav className="tabs" aria-label={t('project')}><NavLink end to={`/p/${encodeURIComponent(params.project)}`}>{t('conversations')}</NavLink><NavLink to={`/p/${encodeURIComponent(params.project)}/changes`}>{t('changes')}</NavLink></nav>}
    <div className="empty-state"><Icon name={future ? 'sparkle' : 'search'} size={22}/>
    <h2>{t(future ? 'futureTitle' : 'emptyTitle')}</h2><p>{t(future ? 'futureBody' : 'emptyBody')}</p></div></div>;
}
/** 旧い依頼の流れの経路は、作業場の右の列へ移す。 */
function RequestsRedirect() {
  const params = useParams(); const location = useLocation();
  const search = new URLSearchParams(location.search); search.set('requests', '1');
  return <Navigate replace to={`/p/${encodeURIComponent(params.project ?? '')}?${search}`}/>;
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
  const roots = useMemo(() => selectRoots(state), [state.projection.roots]);
  const hasOther = roots.some(row => row.project === OTHER_PROJECT || row.project === null);
  const [listError, setListError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setListError('');
    void (async () => {
      for (const [table, page] of Object.entries(state.pages ?? {})) {
        let after = page.next;
        while (after) {
          const next = await fetchProjection<{ rows: Row[]; next: string | null; generation: number }>(`/projection?table=${encodeURIComponent(table)}&after=${encodeURIComponent(after)}`, controller.signal);
          if (controller.signal.aborted || next.generation !== target.getSnapshot().generation) return;
          target.mergeProjection({ [table]: next.rows }, next.generation);
          if (next.next === after) throw new Error('Unable to advance activity list');
          after = next.next;
        }
      }
    })().catch(error => { if (!controller.signal.aborted) setListError(`Unable to load the full activity list. ${error instanceof Error ? error.message : ''}`.trim()); });
    return () => controller.abort();
  }, [state.pages, state.generation, target]);
  const approvals = getInbox(state).pending.length;
  const location = useLocation();
  const { bindings, setBindings } = useKeySettings(client);
  const [overlay, setOverlay] = useState<'commands' | 'help' | 'interrupt' | 'create'>();
  const [stopButton, setStopButton] = useState<HTMLButtonElement>();
  const [commandError, setCommandError] = useState('');
  const answered = useRef(new Set<string>());
  const contextFocus = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pathProject = /^\/p\/([^/]+)/.exec(location.pathname)?.[1];
  const pathConversation = /^\/c\/([^/]+)/.exec(location.pathname)?.[1];

  // 経路のプロジェクトは表示名でも識別子でも受け、投影の projects の識別子に揃える。
  const project = pathProject ? resolveProjectId(state, decodeURIComponent(pathProject)) : roots.find(root => root.conversation_ids.includes(pathConversation ? decodeURIComponent(pathConversation) : ''))?.project || projects[0]?.id;
  const [wide, setWide] = useState(() => window.innerWidth > FILES_COLLAPSE_WIDTH);
  const [expandedProject, setExpandedProject] = useState<{ id: string; open: boolean }>();
  useEffect(() => {
    const resize = () => { setWide(window.innerWidth > FILES_COLLAPSE_WIDTH); if (window.innerWidth <= FILES_COLLAPSE_WIDTH) setExpandedProject(undefined); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const filesOpen = expandedProject && expandedProject.id === project ? expandedProject.open : wide;
  const explorer = useFileExplorer({ client, target, project: pathProject ? decodeURIComponent(pathProject) : project ?? '',
    enabled: Boolean(project) && (filesOpen || location.pathname.endsWith('/files')) });
  const projectRoot = String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '');
  function moveRow(direction: number) {
    const rows = [...(mainRef.current?.querySelectorAll<HTMLElement>('.activity-name, [data-approval-id], .delegation-select, [role="treeitem"][tabindex]') ?? [])];
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
    if (action === 'command' || action === 'help') { contextFocus.current = document.activeElement as HTMLElement; setOverlay(action === 'command' ? 'commands' : 'help'); }
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
    else if (project) navigate(`/p/${encodeURIComponent(project)}${action === 'workspace' ? '' : action === 'tree' ? '?requests=1' : `/${action}`}`);
  }
  const executeRef = useRef(executeKey);
  executeRef.current = executeKey;
  const handleKey = useMemo(() => createKeyHandler(bindings, action => executeRef.current(action)), [bindings, location.pathname, overlay]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (overlay || (event.key === 'Escape' && event.target instanceof HTMLElement && event.target.matches('.explorer-filter input'))) return;
      contextFocus.current = event.target instanceof HTMLElement ? event.target : null;
      if (handleKey(event)) { event.preventDefault(); event.stopPropagation(); }
      else if (!isTextInput(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey && ['a', 'd'].includes(event.key.toLowerCase())) event.stopPropagation();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [handleKey, overlay]);
  const commands: Command[] = [
    ...(['home', 'workspace', 'inbox', 'tree', 'changes', 'help', 'interrupt'] as const).map(id => ({ id, name: KEY_LABELS[id], run: () => executeKey(id), disabled: ['workspace', 'tree', 'changes'].includes(id) && !project })),
    { id: 'search', name: 'Search conversations', run: () => navigate('/search') },
    { id: 'settings', name: 'Open Settings', run: () => navigate('/settings') },
    { id: 'create', name: 'New task', run: () => setOverlay('create') },
    ...roots.map(root => ({ id: `conversation-${root.id}`, name: `Open ${isRunning(root.state) ? 'active ' : ''}conversation: ${root.name}`, run: () => navigate(`/p/${encodeURIComponent(root.project ?? OTHER_PROJECT)}?root=${encodeURIComponent(root.id)}`) })),
    ...getInbox(state).pending.flatMap(row => (['allow', 'deny'] as const).map(action => ({
      id: `${action}-${row.id}`, name: `${action === 'allow' ? 'Allow' : 'Deny'} approval: ${row.id}`,
      disabled: state.connection !== 'connected' || !getDecision(row, action) || answered.current.has(String(row.id)),
      run: () => {
        const id = String(row.id);
        if (answered.current.has(id)) return;
        answered.current.add(id); setCommandError('');
        void answerApproval(client, row, action).catch(error => { answered.current.delete(id); setCommandError(error instanceof Error ? error.message : String(error)); });
      },
    }))),
    ...projects.map(row => ({ id: `workspace-${row.id}`, name: `Open workspace: ${row.full}`, run: () => navigate(`/p/${encodeURIComponent(row.id)}`) })),
  ];
  const fullHeight = /^\/(c|p)\/[^/]+(?:\/files)?$/.test(location.pathname);
  const conversation = (conversationId?: string, embedded = false) => <ConversationPage key={conversationId} conversationId={conversationId} target={target} client={client} language={language} embedded={embedded}
    onConversation={id => navigate(`/c/${encodeURIComponent(id)}`)}/>;
  const icons = { overview: 'overview', inbox: 'inbox', search: 'search' } as const;
  return <div className="app-shell"><aside className="sidebar"><Link className="brand" to="/"><span className="brand-mark"><Icon name="logo" size={16}/></span>{t('brand')}</Link>
    <nav aria-label={t('workspace')} className="nav-group">
      {(['overview', 'inbox', 'search'] as const).map(key => <NavLink key={key} end to={key === 'overview' ? '/' : `/${key}`}><Icon name={icons[key]} size={16}/><span className="nav-label">{t(key)}</span>
        {key === 'inbox' && approvals > 0 && <span className="nav-count numeric" aria-hidden="true">{approvals}</span>}</NavLink>)}
    </nav><div className="projects"><p className="eyebrow">{t('projects')}<span className="numeric">{projects.length}</span></p>
      {projects.length === 0 ? <p className="muted-text sidebar-empty">{t('noProjects')}</p> : <nav aria-label={t('projects')} className="nav-group project-list">{projects.map(row => <div key={row.id} className={row.id === project && filesOpen ? 'sidebar-project expanded' : 'sidebar-project'}>
        <div className="sidebar-project-row"><button className="icon-button" aria-label={`Toggle files for ${row.name}`} aria-expanded={row.id === project && filesOpen}
          onClick={() => { setExpandedProject({ id: row.id, open: row.id !== project || !filesOpen }); if (row.id !== project) navigate(`/p/${encodeURIComponent(row.id)}`); }}>
          <Icon name={row.id === project && filesOpen ? 'chevronDown' : 'chevronRight'} size={12}/></button>
          <NavLink to={`/p/${encodeURIComponent(row.id)}`} title={row.full} aria-label={row.full}>
            <Icon name="folder" size={16}/><span className="project-link"><span className="truncate">{row.name}</span></span></NavLink></div>
        {row.id === project && filesOpen && <div className="sidebar-files"><FileTreePanel explorer={explorer}/><FileNotices explorer={explorer}/></div>}
      </div>)}</nav>}
    {hasOther && <nav className="nav-group" aria-label={t('other')}><div className="sidebar-project-row"><span className="sidebar-indent"/><NavLink to="/p/other"><Icon name="folder" size={16}/><span className="project-link"><span className="truncate">{t('other')}</span></span></NavLink></div></nav>}</div><NavLink className="settings-link" to="/settings"><Icon name="settings" size={16}/>{t('settings')}</NavLink></aside>
    <div className="main-column">{listError && <p role="alert" className="status-line danger list-error">{listError}</p>}<header className="topbar"><span className={`connection ${state.connection}`} role="status">{state.connection !== 'connected' && <><span className="connection-dot" aria-hidden="true"/>{t(state.connection)}</>}</span>
      <div className="topbar-actions"><button className="btn btn-ghost btn-sm" onClick={() => { contextFocus.current = document.activeElement as HTMLElement; setOverlay('commands'); }}><Icon name="search" size={14}/><span>{t('commands')}</span><kbd>{bindings.command}</kbd></button>{approvals > 0 && <Link className="approval-count" to="/inbox"><span className="status status-waiting"><span className="status-dot" aria-hidden="true"/></span>{t('approvals')}<strong className="numeric">{approvals}</strong></Link>}
      <Notifications target={target} client={client} initiallyOpen={false} compact language={language}/></div>
    </header><main ref={mainRef} className={fullHeight ? 'full-height' : undefined}><Routes>
      <Route path="/" element={<HomePage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project" element={<WorkspacePage target={target} client={client} language={language}/>}/>
      <Route path="/c/:conversation" element={conversation()}/>
      <Route path="/inbox" element={<Inbox target={target} client={client}/>}/>
      <Route path="/p/:project/tree" element={<RequestsRedirect/>}/>
      <Route path="/p/:project/changes" element={<ChangesPage target={target} client={client}/>}/>
      <Route path="/p/:project/files" element={<div className="files-page"><FileNotices explorer={explorer}/><FileViewerPanel explorer={explorer} actions={<button className="btn btn-ghost btn-xs" onClick={explorer.closeFile}><Icon name="chevronLeft" size={12}/>Back</button>}/></div>}/>
      <Route path="/search" element={<SearchPage target={target} client={searchClient} language={language}/>}/>
      <Route path="/settings" element={<div className="page settings-page"><header className="page-header"><h1>{t('settings')}</h1></header><div className="settings-card">
        <label><span><strong>{t('theme')}</strong><small>{t('themeHint')}</small></span><select aria-label={t('theme')} value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label><span><strong>{t('language')}</strong><small>{t('languageHint')}</small></span><select aria-label={t('language')} value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en" lang="en">{t('english')}</option><option value="ja" lang="ja">{t('japanese')}</option></select></label>
      </div><KeyboardSettings bindings={bindings} client={client} onSave={setBindings}/></div>}/>
      <Route path="*" element={<EmptyView title="notFound" t={t}/>}/>
    </Routes>{commandError && <p role="alert" className="banner banner-danger">{commandError}</p>}</main></div>
    {overlay === 'commands' && <CommandPalette commands={commands} onClose={() => setOverlay(undefined)}/>}
    {overlay === 'help' && <CommandDialog title="Shortcuts" onClose={() => setOverlay(undefined)}><dl>{Object.entries(bindings).map(([key, value]) => <div key={key}><dt>{KEY_LABELS[key as KeyAction]}</dt><dd><kbd>{value}</kbd></dd></div>)}</dl></CommandDialog>}
    {overlay === 'interrupt' && <CommandDialog title="Interrupt run?" onClose={() => setOverlay(undefined)}><p>Interrupt the current run?</p><button className="btn btn-primary" onClick={() => { if (stopButton?.isConnected && !stopButton.disabled) stopButton.click(); setOverlay(undefined); }}>Confirm interrupt</button><button className="btn btn-secondary" onClick={() => setOverlay(undefined)}>Cancel</button></CommandDialog>}
    {overlay === 'create' && <CommandDialog title="New task" onClose={() => setOverlay(undefined)}><CreateTaskForm project={project ?? ''} root={projectRoot} client={client} disabled={state.connection !== 'connected'} language={language} onCancel={() => setOverlay(undefined)}/></CommandDialog>}
    </div>;
}
export function Dashboard({ client, searchClient }: { client: ConversationClient; searchClient?: SearchClient }) { return <BrowserRouter><App client={client} searchClient={searchClient}/></BrowserRouter>; }
