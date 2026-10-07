import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router';
import { dictionaries, type Language, type TextKey } from './lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from './lib/store.ts';
import type { ConversationClient } from './pages/conversation/ConversationPage.tsx';
import { ConversationPage } from './pages/conversation/ConversationPage.tsx';
import { HomePage } from './pages/home/HomePage.tsx';
import { WorkspacePage } from './pages/workspace/WorkspacePage.tsx';
import { TreePage } from './pages/tree/TreePage.tsx';
import { ChangesPage } from './pages/changes/ChangesPage.tsx';
import { FilesPage } from './pages/files/FilesPage.tsx';
import { SearchPage } from './pages/search/SearchPage.tsx';
import { createSearchClient, type SearchClient } from './pages/search/model.ts';
import { Inbox } from './pages/inbox/Inbox.tsx';
import { getInbox } from './pages/inbox/model.ts';
import { Notifications } from './components/notifications/Notifications.tsx';
import { selectActivities } from './components/activity.ts';
import { Icon } from './components/Icon.tsx';
import { projectLabel } from './lib/format.ts';
import './styles.css';

export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(theme: Theme, dark: boolean) {
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}
function EmptyView({ title, future, t }: { title: TextKey; future?: boolean; t: (key: TextKey) => string }) {
  const params = useParams();
  return <div className="page"><header className="page-header"><div className="page-title"><p className="eyebrow">{t('workspace')}</p><h1>{t(title)}</h1></div></header>
    {params.project && <nav className="tabs" aria-label={t('project')}><NavLink end to={`/p/${encodeURIComponent(params.project)}`}>{t('project')}</NavLink><NavLink to={`/p/${encodeURIComponent(params.project)}/tree`}>{t('tree')}</NavLink><NavLink to={`/p/${encodeURIComponent(params.project)}/changes`}>{t('changes')}</NavLink><NavLink to={`/p/${encodeURIComponent(params.project)}/files`}>Files</NavLink></nav>}
    <div className="empty-state"><Icon name={future ? 'sparkle' : 'search'} size={22}/>
    <h2>{t(future ? 'futureTitle' : 'emptyTitle')}</h2><p>{t(future ? 'futureBody' : 'emptyBody')}</p></div></div>;
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
  const projects = [...new Set(selectActivities(state).map(row => row.project).filter(Boolean))].sort().map(id => ({ id, ...projectLabel(id) }));
  const approvals = getInbox(state).pending.length;
  const location = useLocation();
  const fullHeight = /^\/(c|p)\/[^/]+$/.test(location.pathname) || /^\/p\/[^/]+\/files$/.test(location.pathname);
  const conversation = (conversationId?: string, embedded = false) => <ConversationPage key={conversationId} conversationId={conversationId} target={target} client={client} language={language} embedded={embedded}
    onConversation={id => navigate(`/c/${encodeURIComponent(id)}`)}/>;
  const icons = { overview: 'overview', inbox: 'inbox', search: 'search' } as const;
  return <div className="app-shell"><aside className="sidebar"><Link className="brand" to="/"><span className="brand-mark"><Icon name="logo" size={16}/></span>{t('brand')}</Link>
    <nav aria-label={t('workspace')} className="nav-group">
      {(['overview', 'inbox', 'search'] as const).map(key => <NavLink key={key} end to={key === 'overview' ? '/' : `/${key}`}><Icon name={icons[key]} size={16}/><span className="nav-label">{t(key)}</span>
        {key === 'inbox' && approvals > 0 && <span className="nav-count numeric" aria-hidden="true">{approvals}</span>}</NavLink>)}
    </nav><div className="projects"><p className="eyebrow">{t('projects')}<span className="numeric">{projects.length}</span></p>
      {projects.length === 0 ? <p className="muted-text sidebar-empty">{t('noProjects')}</p> : <nav aria-label={t('projects')} className="nav-group">{projects.map(row => <NavLink key={row.id} to={`/p/${encodeURIComponent(row.id)}`} title={row.full} aria-label={row.full}>
        <Icon name="folder" size={16}/><span className="project-link"><span className="truncate">{row.name}</span>{row.detail && <span className="project-path truncate">{row.detail}</span>}</span></NavLink>)}</nav>}
    </div><NavLink className="settings-link" to="/settings"><Icon name="settings" size={16}/>{t('settings')}</NavLink></aside>
    <div className="main-column"><header className="topbar"><span className={`connection ${state.connection}`} role="status"><span className="connection-dot" aria-hidden="true"/>{t(state.connection)}</span>
      <div className="topbar-actions"><Link className="approval-count" to="/inbox"><Icon name="inbox" size={15}/>{t('approvals')}<strong className="numeric">{approvals}</strong></Link>
      <Notifications target={target} client={client} initiallyOpen={false} compact language={language}/></div>
    </header><main className={fullHeight ? 'full-height' : undefined}><Routes>
      <Route path="/" element={<HomePage target={target} language={language}/>}/>
      <Route path="/p/:project" element={<WorkspacePage target={target} client={client} language={language} renderConversation={id => conversation(id, true)}/>}/>
      <Route path="/c/:conversation" element={conversation()}/>
      <Route path="/inbox" element={<Inbox target={target} client={client}/>}/>
      <Route path="/p/:project/tree" element={<TreePage target={target} client={client} language={language}/>}/>
      <Route path="/p/:project/changes" element={<ChangesPage target={target} client={client}/>}/>
      <Route path="/p/:project/files" element={<FilesPage target={target} client={client}/>}/>
      <Route path="/search" element={<SearchPage client={searchClient} language={language}/>}/>
      <Route path="/settings" element={<div className="page"><header className="page-header"><div className="page-title"><p className="eyebrow">{t('workspace')}</p><h1>{t('settings')}</h1></div></header><div className="settings-card">
        <label><span><strong>{t('theme')}</strong><small>{t('themeHint')}</small></span><select aria-label={t('theme')} value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label><span><strong>{t('language')}</strong><small>{t('languageHint')}</small></span><select aria-label={t('language')} value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en" lang="en">{t('english')}</option><option value="ja" lang="ja">{t('japanese')}</option></select></label>
      </div></div>}/>
      <Route path="*" element={<EmptyView title="notFound" t={t}/>}/>
    </Routes></main></div></div>;
}
export function Dashboard({ client, searchClient }: { client: ConversationClient; searchClient?: SearchClient }) { return <BrowserRouter><App client={client} searchClient={searchClient}/></BrowserRouter>; }
