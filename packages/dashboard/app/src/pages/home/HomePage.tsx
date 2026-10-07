import { useState } from 'react';
import { Link } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { ActivityRow } from '../../components/ActivityRow.tsx';
import { executionStates, selectActivities, type ActivitySection } from '../../components/activity.ts';
import { useNow } from '../../components/RelativeTime.tsx';
import '../../components/activity.css';

export function HomePage({ target = store, language = 'en' }: { target?: ScreenStore; language?: Language }) {
  const state = useScreenStore(target);
  const now = useNow();
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [project, setProject] = useState('');
  const activities = selectActivities(state);
  const projects = [...new Set(activities.map(item => item.project))].sort();
  const visible = activities.filter(item => (!status || item.state === status) && (!provider || item.provider === provider) && (!project || item.project === project));
  const ja = language === 'ja';
  const sections: [ActivitySection, string][] = [['managed', ja ? 'プロジェクト' : 'Projects'], ['external', ja ? '外の会話' : 'External conversations'],
    ['unattended', ja ? '無人実行' : 'Unattended runs'], ['unsupported', ja ? '形式未対応の会話' : 'Unsupported conversations']];
  return <section><div className="page-heading"><h1>{ja ? '一覧' : 'Overview'}</h1></div>
    <div className="activity-filters">
      <label>{ja ? '状態' : 'State'}<select value={status} onChange={event => setStatus(event.target.value)}><option value="">{ja ? 'すべての状態' : 'All states'}</option>{executionStates.map(value => <option key={value} value={value}>{value === 'starting' ? (ja ? '起動中' : 'Starting') : dictionaries[language][value]}</option>)}</select></label>
      <label>Provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="">{ja ? 'すべて' : 'All providers'}</option>{[...new Set(activities.map(item => item.provider))].sort().map(value => <option key={value}>{value}</option>)}</select></label>
      <label>{ja ? 'プロジェクト' : 'Project'}<select value={project} onChange={event => setProject(event.target.value)}><option value="">{ja ? 'すべてのプロジェクト' : 'All projects'}</option>{projects.filter(Boolean).map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={() => { setStatus(''); setProvider(''); setProject(''); }}>{ja ? '解除' : 'Clear filters'}</button>
    </div>
    {sections.map(([kind, title]) => <section className="activity-group" key={kind} aria-label={title}><h2>{title}</h2>
      {kind === 'managed' ? projects.map(id => {
        const rows = visible.filter(item => item.section === kind && item.project === id);
        return rows.length ? <section key={id} aria-label={id || 'No project'}><div className="activity-toolbar"><h3><Link to={`/p/${encodeURIComponent(id)}`}>{id || (ja ? 'プロジェクトなし' : 'No project')}</Link></h3>
          {id && <Link to={`/p/${encodeURIComponent(id)}?create=1`}>{ja ? '作業を作る' : 'Create task'}</Link>}</div>{rows.map(item => <ActivityRow key={item.id} activity={item} now={now} language={language}/>)}</section> : null;
      }) : visible.filter(item => item.section === kind).map(item => <ActivityRow key={item.id} activity={item} now={now} language={language}
        actions={item.conversationId && <>
          <Link to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</Link>
          {item.section === 'external' && <Link to={`/c/${encodeURIComponent(item.conversationId)}?adopt=1`}>{ja ? '引き継ぐ' : 'Take over'}</Link>}
          {item.state === 'unknown' && <Link to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '根拠を確認' : 'Review evidence'}</Link>}
        </>}/>)}
      {!visible.some(item => item.section === kind) && <p className="muted">{ja ? '該当する作業はありません' : 'No matching activity'}</p>}
    </section>)}
  </section>;
}
export default HomePage;
