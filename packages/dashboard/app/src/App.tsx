import { useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useParams } from 'react-router';
import { dictionaries, type Language, type TextKey } from './lib/i18n.ts';
import { store, useScreenStore, type ScreenStore } from './lib/store.ts';
import './styles.css';

export type Theme = 'system' | 'light' | 'dark';
export function applyTheme(theme: Theme, dark: boolean) {
  document.documentElement.dataset.theme = theme === 'system' ? (dark ? 'dark' : 'light') : theme;
}
function EmptyView({ title, future, t }: { title: TextKey; future?: boolean; t: (key: TextKey) => string }) {
  const params = useParams();
  return <section><div className="page-heading"><p className="eyebrow">{t('workspace')}</p><h1>{t(title)}</h1>
    {params.project && <div className="project-tabs"><Link to={`/p/${encodeURIComponent(params.project)}`}>{t('project')}</Link><Link to={`/p/${encodeURIComponent(params.project)}/tree`}>{t('tree')}</Link><Link to={`/p/${encodeURIComponent(params.project)}/changes`}>{t('changes')}</Link></div>}
  </div><div className="empty-state"><span className="empty-symbol" aria-hidden="true">◇</span>
    <h2>{t(future ? 'futureTitle' : 'emptyTitle')}</h2><p>{t(future ? 'futureBody' : 'emptyBody')}</p></div></section>;
}
export function App({ target = store }: { target?: ScreenStore }) {
  const state = useScreenStore(target);
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('agent-graph-language') === 'ja' ? 'ja' : 'en');
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('agent-graph-theme');
    return saved === 'dark' || saved === 'light' ? saved : 'system';
  });
  const [notifications, setNotifications] = useState(false);
  const t = (key: TextKey) => dictionaries[language][key];
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme, media.matches);
    update(); media.addEventListener('change', update);
    localStorage.setItem('agent-graph-theme', theme);
    return () => media.removeEventListener('change', update);
  }, [theme]);
  useEffect(() => { document.documentElement.lang = language; localStorage.setItem('agent-graph-language', language); }, [language]);
  const projects = [...new Set((state.projection.tasks ?? []).flatMap(row => typeof row.project === 'string' && row.project ? [row.project] : []))].map(id => ({ id, name: id }));
  const approvals = (state.projection.approvals ?? []).filter(row => row.state === 'pending').length;
  return <div className="app-shell"><aside className="sidebar"><Link className="brand" to="/"><span aria-hidden="true">⌘</span>{t('brand')}</Link>
    <p className="eyebrow">{t('workspace')}</p><nav aria-label={t('workspace')}>
      {(['overview', 'inbox', 'search'] as const).map(key => <NavLink key={key} end to={key === 'overview' ? '/' : `/${key}`}><span aria-hidden="true">{key === 'overview' ? '▦' : key === 'inbox' ? '▤' : '⌕'}</span>{t(key)}</NavLink>)}
    </nav><div className="projects"><p className="eyebrow">{t('projects')}<span>{projects.length}</span></p>
      {projects.length === 0 ? <p className="muted">{t('noProjects')}</p> : projects.map(row => <NavLink key={String(row.id)} to={`/p/${encodeURIComponent(String(row.id))}`}>{String(row.name ?? row.id)}</NavLink>)}
    </div><NavLink className="settings-link" to="/settings"><span aria-hidden="true">⚙</span>{t('settings')}</NavLink></aside>
    <div className="main-column"><header className="topbar"><span className={`connection ${state.connection}`} role="status"><span aria-hidden="true">●</span>{t(state.connection)}</span>
      <div className="topbar-actions"><Link className="approval-count" to="/inbox">{t('approvals')}<strong>{approvals}</strong></Link>
      <button className="bell" aria-label={t('notifications')} aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></button></div>
      {notifications && <section className="notification-panel" aria-label={t('notifications')}><h2>{t('notifications')}</h2><p>{t('noNotifications')}</p></section>}
    </header><main><Routes>
      <Route path="/" element={<EmptyView title="overview" t={t}/>}/>
      <Route path="/p/:project" element={<EmptyView title="project" t={t}/>}/>
      <Route path="/c/:conversation" element={<EmptyView title="conversation" t={t}/>}/>
      <Route path="/inbox" element={<EmptyView title="inbox" t={t}/>}/>
      <Route path="/p/:project/tree" element={<EmptyView title="tree" future t={t}/>}/>
      <Route path="/p/:project/changes" element={<EmptyView title="changes" future t={t}/>}/>
      <Route path="/search" element={<EmptyView title="search" future t={t}/>}/>
      <Route path="/settings" element={<section><div className="page-heading"><p className="eyebrow">{t('workspace')}</p><h1>{t('settings')}</h1></div><div className="settings-card">
        <label>{t('theme')}<select value={theme} onChange={event => setTheme(event.target.value as Theme)}>{(['system', 'light', 'dark'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
        <label>{t('language')}<select value={language} onChange={event => setLanguage(event.target.value as Language)}><option value="en" lang="en">{t('english')}</option><option value="ja" lang="ja">{t('japanese')}</option></select></label>
      </div></section>}/>
      <Route path="*" element={<EmptyView title="notFound" t={t}/>}/>
    </Routes></main></div></div>;
}
export function Dashboard() { return <BrowserRouter><App/></BrowserRouter>; }
