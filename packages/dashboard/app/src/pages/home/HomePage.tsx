import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { projectLabel } from '../../lib/format.ts';
import { ActivityRow, providerName } from '../../components/ActivityRow.tsx';
import { executionStates, selectActivities, type Activity, type ActivitySection } from '../../components/activity.ts';
import { useNow } from '../../components/RelativeTime.tsx';
import { Icon } from '../../components/Icon.tsx';
import '../../components/activity.css';

export function TableHead({ language = 'en' }: { language?: Language }) {
  const ja = language === 'ja';
  return <div className="table-head" aria-hidden="true"><span>{ja ? '名前' : 'Name'}</span><span>{ja ? '状態' : 'State'}</span>
    <span>{ja ? 'エージェント' : 'Agent'}</span><span className="numeric">{ja ? '経過' : 'Elapsed'}</span><span className="numeric">{ja ? '変更' : 'Changes'}</span><span/></div>;
}
export function ProjectName({ path, link = true }: { path: string; link?: boolean }) {
  const label = projectLabel(path);
  const content = <><Icon name="folder" size={15}/><span className="project-name truncate">{label.name}</span>{label.detail && <span className="project-path truncate">{label.detail}</span>}</>;
  return link && path ? <Link className="project-heading" to={`/p/${encodeURIComponent(path)}`} title={label.full}>{content}</Link>
    : <span className="project-heading" title={label.full}>{content}</span>;
}
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
  const filtered = Boolean(status || provider || project);
  const count = (states: string[]) => activities.filter(item => states.includes(item.state)).length;
  const summary = [[count(['starting', 'running']), ja ? '実行中' : 'running'], [count(['waiting_approval', 'waiting_input']), ja ? '待ち' : 'waiting'],
    [count(['unknown']), ja ? '不明' : 'unknown']] as const;
  const sections: [ActivitySection, string, string][] = [
    ['managed', ja ? 'プロジェクト' : 'Projects', ja ? 'runner が起動した作業' : 'Tasks started by the runner'],
    ['external', ja ? '外の会話' : 'External conversations', ja ? '外のターミナルで始まった会話' : 'Observed from other terminals; read-only until taken over'],
    ['unattended', ja ? '無人実行' : 'Unattended runs', ja ? '名前のない自動の実行' : 'Automated runs without a conversation name'],
    ['unsupported', ja ? '形式未対応の会話' : 'Unsupported conversations', ja ? '履歴の形式に未対応' : 'History format not supported yet']];
  const rows = (items: Activity[], actions?: (item: Activity) => ReactNode) => <div className="table" role="presentation"><TableHead language={language}/>
    {items.map(item => <ActivityRow key={item.id} activity={item} now={now} language={language} actions={actions?.(item)}/>)}</div>;
  return <div className="page">
    <header className="page-header"><div className="page-title"><h1>{ja ? '一覧' : 'Overview'}</h1>
      <p className="page-subtitle">{summary.map(([value, label]) => <span key={label}><strong className="numeric">{value}</strong> {label}</span>)}</p></div></header>
    <div className="toolbar" role="group" aria-label={ja ? '絞り込み' : 'Filters'}>
      <Icon name="filter" size={14} className="toolbar-icon"/>
      <label className="inline-field">{ja ? '状態' : 'State'}<select value={status} onChange={event => setStatus(event.target.value)}><option value="">{ja ? 'すべての状態' : 'All states'}</option>{executionStates.map(value => <option key={value} value={value}>{value === 'starting' ? (ja ? '起動中' : 'Starting') : dictionaries[language][value]}</option>)}</select></label>
      <label className="inline-field">Provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="">{ja ? 'すべて' : 'All providers'}</option>{[...new Set(activities.map(item => item.provider))].filter(Boolean).sort().map(value => <option key={value} value={value}>{providerName(value)}</option>)}</select></label>
      <label className="inline-field">{ja ? 'プロジェクト' : 'Project'}<select value={project} onChange={event => setProject(event.target.value)}><option value="">{ja ? 'すべてのプロジェクト' : 'All projects'}</option>{projects.filter(Boolean).map(value => <option key={value} value={value} title={value}>{projectLabel(value).name}</option>)}</select></label>
      <button className="btn btn-ghost btn-sm" disabled={!filtered} onClick={() => { setStatus(''); setProvider(''); setProject(''); }}>{ja ? '解除' : 'Clear filters'}</button>
    </div>
    {sections.map(([kind, title, description]) => {
      const items = visible.filter(item => item.section === kind);
      return <section className="activity-group" key={kind} aria-label={title}>
        <header className="section-header"><h2>{title}<span className="count-pill">{items.length}</span></h2><p>{description}</p></header>
        {kind === 'managed' ? projects.map(id => {
          const group = items.filter(item => item.project === id);
          return group.length ? <section className="table-group" key={id} aria-label={id || 'No project'}>
            <header className="group-header"><h3>{id ? <ProjectName path={id}/> : <span className="project-heading">{ja ? 'プロジェクトなし' : 'No project'}</span>}</h3>
              {id && <Link className="btn btn-ghost btn-sm" to={`/p/${encodeURIComponent(id)}?create=1`}><Icon name="plus" size={14}/>{ja ? '作業を作る' : 'Create task'}</Link>}</header>
            {rows(group)}</section> : null;
        }) : items.length > 0 && <div className="table-group">{rows(items, item => item.conversationId && <>
          {item.section === 'external' && <Link className="btn btn-secondary btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}?adopt=1`}>{ja ? '引き継ぐ' : 'Take over'}</Link>}
          {item.state === 'unknown' ? <Link className="btn btn-ghost btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '根拠を確認' : 'Review evidence'}</Link>
            : <Link className="btn btn-ghost btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</Link>}
        </>)}</div>}
        {items.length === 0 && <p className="empty-row">{filtered ? (ja ? '該当する作業はありません' : 'No matching activity') : (ja ? 'まだありません' : 'Nothing here yet')}</p>}
      </section>;
    })}
  </div>;
}
export default HomePage;
