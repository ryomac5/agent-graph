import { useEffect, useMemo, useRef, useState } from 'react';
import { createKeyHandler, isTextInput, keyLabel, type KeyAction } from './lib/keys.ts';
import { CommandDialog, CommandPalette, KeyboardSettings, useKeySettings, type Command } from './components/command/Commands.tsx';
import { CreateTaskForm } from './components/CreateTaskForm.tsx';
import './components/command/command.css';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { dictionaries, type Language, type TextKey } from './lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from './lib/store.ts';
import type { ConversationClient } from './pages/conversation/ConversationPage.tsx';
import { HomePage } from './pages/home/HomePage.tsx';
import { FileNotices, FileTreePanel, FileViewerPanel, useFileExplorer } from './pages/files/FilesPage.tsx';
import { WorkspacePage } from './pages/workspace/WorkspacePage.tsx';
import { GraphPage } from './pages/graph/GraphPage.tsx';
import { ChangesPage } from './pages/changes/ChangesPage.tsx';
import { SearchPage } from './pages/search/SearchPage.tsx';
import { createSearchClient, type SearchClient } from './pages/search/model.ts';
import { Inbox } from './pages/inbox/Inbox.tsx';
import { answerApproval, getDecision, getInbox } from './pages/inbox/model.ts';
import { TurnSignals } from './components/TurnSignals.tsx';
import { Notifications } from './components/notifications/Notifications.tsx';
import { selectRoots, isRunning, rootProject, buildRootTree, useRootIndex } from './lib/roots.ts';
import { RootList } from './components/RootViews.tsx';
import { Icon } from './components/Icon.tsx';
import { fetchProjection } from './lib/projection-client.ts';
import type { Row } from './lib/store.ts';
import { getRegisteredProjects, OTHER_PROJECT, resolveProjectId } from './lib/projects.ts';
import './styles.css';


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

  const directRoot = pathConversation ? roots.find(root => root.conversation_ids.includes(decodeURIComponent(pathConversation)) || buildRootTree(root, rootIndex).nodes.some(node => node.conversationId === decodeURIComponent(pathConversation))) : undefined;
  // 経路のプロジェクトは表示名でも識別子でも受け、投影の projects の識別子に揃える。
  const project = pathProject ? resolveProjectId(state, decodeURIComponent(pathProject)) : directRoot?.project || projects[0]?.id;
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [mobileView, setMobileView] = useState('conversation');
  const [search] = useSearchParams();
  const rootQuery = search.get('root'); const childQuery = search.get('child');
  useEffect(() => { setMobileView('conversation'); }, [location.pathname, rootQuery, childQuery]);
  const explorer = useFileExplorer({ client, target, project: pathProject ? decodeURIComponent(pathProject) : project ?? '', enabled: location.pathname.endsWith('/files') });
  const projectRoot = String(state.projection.projects?.find(row => row.id === project)?.root_path ?? '');
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
    else if (project) navigate(`/p/${encodeURIComponent(project)}${action === 'workspace' ? '' : action === 'tree' ? '/graph' : `/${action}`}`);
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
    ...(['home', 'workspace', 'inbox', 'tree', 'changes', 'help', 'interrupt'] as const).map(id => ({ id, name: keyLabel(id, language), run: () => executeKey(id), disabled: ['workspace', 'tree', 'changes'].includes(id) && !project })),
    { id: 'search', name: language === 'ja' ? '会話を検索' : 'Search conversations', run: () => navigate('/search') },
    { id: 'settings', name: language === 'ja' ? '設定を開く' : 'Open Settings', run: () => navigate('/settings') },
    { id: 'create', name: t('newTask'), run: () => setOverlay('create') },
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
    ...projects.map(row => ({ id: `workspace-${row.id}`, name: language === 'ja' ? `作業場を開く: ${row.full}` : `Open workspace: ${row.full}`, run: () => navigate(`/p/${encodeURIComponent(row.id)}`) })),
  ];
  const fullHeight = /^\/(c|p)\/[^/]+(?:\/(files|graph|tree))?$/.test(location.pathname);
  const icons = { overview: 'overview', inbox: 'inbox', search: 'search' } as const;
  return <div className={`app-shell mobile-${mobileView}`}><TurnSignals target={target} bindings={bindings}/><aside className="sidebar"><div className="sidebar-brand-row"><Link className="brand" to="/"><span className="brand-mark"><Icon name="logo" size={16}/></span>{t('brand')}</Link><div className="sidebar-actions"><button className="btn btn-ghost btn-sm" aria-label={t('commands')} title={t('commands')} onClick={() => { contextFocus.current = document.activeElement as HTMLElement; setOverlay('commands'); }}><Icon name="search" size={14}/><kbd>{bindings.command}</kbd></button>
      <Notifications target={target} client={client} initiallyOpen={false} compact language={language}/></div>
    </div>{state.connection !== 'connected' && <span className={`connection ${state.connection}`} role="status"><span className="connection-dot" aria-hidden="true"/>{t(state.connection)}</span>}
    <nav aria-label={t('workspace')} className="nav-group">
      {(['overview', 'inbox', 'search'] as const).map(key => <NavLink key={key} end to={key === 'overview' ? '/' : `/${key}`}><Icon name={icons[key]} size={16}/><span className="nav-label">{t(key)}</span>
        {key === 'inbox' && approvals > 0 && <span className="nav-count numeric" aria-hidden="true">{approvals}</span>}</NavLink>)}
    </nav><div className="projects"><p className="eyebrow">{t('projects')}<span className="numeric">{projects.length}</span></p>
      {projects.length === 0 && <p className="muted-text sidebar-empty">{t('noProjects')}</p>}
      <nav aria-label={t('projects')} className="nav-group project-list">{[...projects, ...(hasOther ? [{ id: OTHER_PROJECT, name: t('other'), full: t('other'), detail: '' }] : [])].map(row => {
        const items = roots.filter(root => rootProject(root, registeredIds) === row.id);
        const open = !(collapsedProjects[row.id] ?? row.id !== project);
        const runningCount = items.filter(root => isRunning(root.state)).length;
        return <div key={row.id} className="sidebar-project">
          <div className="sidebar-project-row"><button className="icon-button" aria-label={language === 'ja' ? row.name + ' のセッション' : 'Toggle sessions for ' + row.name} aria-expanded={open} onClick={() => setCollapsedProjects(value => ({ ...value, [row.id]: open }))}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12}/></button>
            <NavLink to={`/p/${encodeURIComponent(row.id)}`} title={row.full}><Icon name="folder" size={14}/><span className="truncate">{row.name}</span></NavLink>
            {runningCount > 0 && <span className="numeric project-running" aria-label={language === 'ja' ? '実行中のセッション' : 'Running sessions'}>{runningCount}</span>}
            <button className="icon-button" aria-label={t('newTask') + ': ' + row.name} onClick={() => { navigate(`/p/${encodeURIComponent(row.id)}?create=1`); setMobileView('conversation'); }}><Icon name="plus" size={14}/></button></div>
          {open && <section className="sidebar-roots" aria-label={language === 'ja' ? row.name + ' のセッション' : row.name + ' sessions'}><RootList grouped state={state} roots={items} selected={selectedRoot?.id} language={language} onSelect={root => { const next = new URLSearchParams(search); next.set('root', root.id); next.delete('child'); next.delete('path'); next.delete('create'); navigate(`/p/${encodeURIComponent(row.id)}?${next}`); setMobileView('conversation'); }}/></section>}
        </div>;
      })}</nav>
    </div><NavLink className="settings-link" to="/settings"><Icon name="settings" size={16}/>{t('settings')}</NavLink></aside>
    <nav className="mobile-tabs" aria-label={language === 'ja' ? '画面' : 'Views'}>{(['sessions', 'conversation', 'panel'] as const).map(view => <button key={view} aria-pressed={mobileView === view} onClick={() => setMobileView(view)}>{language === 'ja' ? { sessions: 'セッション', conversation: '会話', panel: 'パネル' }[view] : { sessions: 'Sessions', conversation: 'Conversation', panel: 'Panel' }[view]}</button>)}</nav>
    <div className="main-column">{listError && <p role="alert" className="status-line danger list-error">{listError}</p>}<main ref={mainRef} className={fullHeight ? 'full-height' : undefined}><Routes>
      <Route path="/" element={<HomePage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project" element={<WorkspacePage target={target} client={client} language={language} showRootList={false}/>}/>
      <Route path="/c/:conversation" element={<WorkspacePage project={project ?? OTHER_PROJECT} conversationId={pathConversation ? decodeURIComponent(pathConversation) : undefined} target={target} client={client} language={language} showRootList={false}/>}/>
      <Route path="/inbox" element={<Inbox target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/tree" element={<RequestsRedirect/>}/>
      <Route path="/p/:project/graph" element={<GraphPage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/changes" element={<ChangesPage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/files" element={<div className="files-page"><FileTreePanel explorer={explorer} language={language}/><FileNotices explorer={explorer}/><FileViewerPanel explorer={explorer} actions={<button className="btn btn-ghost btn-xs" onClick={explorer.closeFile}><Icon name="chevronLeft" size={12}/>Back</button>}/></div>}/>
      <Route path="/search" element={<SearchPage target={target} client={searchClient} language={language}/>}/>
      <Route path="/settings" element={<div className="page settings-page"><header className="page-header"><h1>{t('settings')}</h1></header><div className="settings-card">
        <label><span><strong>{t('theme')}</strong><small>{t('themeHint')}</small></span><select aria-label={t('theme')} value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label><span><strong>{t('language')}</strong><small>{t('languageHint')}</small></span><select aria-label={t('language')} value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en" lang="en">{t('english')}</option><option value="ja" lang="ja">{t('japanese')}</option></select></label>
      </div><KeyboardSettings language={language} bindings={bindings} client={client} onSave={setBindings}/></div>}/>
      <Route path="*" element={<EmptyView title="notFound" t={t}/>}/>
    </Routes>{commandError && <p role="alert" className="banner banner-danger">{commandError}</p>}</main></div>
    {overlay === 'commands' && <CommandPalette language={language} commands={commands} onClose={() => setOverlay(undefined)}/>}
    {overlay === 'help' && <CommandDialog language={language} title={language === 'ja' ? 'キー操作' : 'Shortcuts'} onClose={() => setOverlay(undefined)}><dl>{Object.entries(bindings).map(([key, value]) => <div key={key}><dt>{keyLabel(key as KeyAction, language)}</dt><dd><kbd>{value}</kbd></dd></div>)}</dl></CommandDialog>}
    {overlay === 'interrupt' && <CommandDialog language={language} title={language === 'ja' ? '実行を中断しますか' : 'Interrupt run?'} onClose={() => setOverlay(undefined)}><p>{language === 'ja' ? '現在の実行を中断しますか' : 'Interrupt the current run?'}</p><button className="btn btn-primary" onClick={() => { if (stopButton?.isConnected && !stopButton.disabled) stopButton.click(); setOverlay(undefined); }}>{language === 'ja' ? '中断' : 'Confirm interrupt'}</button><button className="btn btn-secondary" onClick={() => setOverlay(undefined)}>{language === 'ja' ? 'キャンセル' : 'Cancel'}</button></CommandDialog>}
    {overlay === 'create' && <CommandDialog language={language} title={t('newTask')} onClose={() => setOverlay(undefined)}><CreateTaskForm project={project ?? ''} root={projectRoot} client={client} disabled={state.connection !== 'connected'} language={language} onCancel={() => setOverlay(undefined)}/></CommandDialog>}
    </div>;
}
export function Dashboard({ client, searchClient }: { client: ConversationClient; searchClient?: SearchClient }) { return <BrowserRouter><App client={client} searchClient={searchClient}/></BrowserRouter>; }
