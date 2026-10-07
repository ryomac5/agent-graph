import { useProvisionalNames } from '../../lib/provisional-names.ts';
import type { ConversationClient } from '../conversation/ConversationPage.tsx';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { store, useScreenStore, type ScreenState, type ScreenStore } from '../../lib/store.ts';
import { dictionaries, type Language } from '../../lib/i18n.ts';
import { projectLabel } from '../../lib/format.ts';
import { getRegisteredProjects, getProjectName, OTHER_PROJECT } from '../../lib/projects.ts';
import { ActivityRow, providerName } from '../../components/ActivityRow.tsx';
import { executionStates, selectActivities, orderActivities, type Activity } from '../../components/activity.ts';
import { buildOverview, countActiveDelegations, countAllDelegations, type ProjectGroup, type WorkItem } from '../../components/overview.ts';
import { DelegationFold } from '../../components/DelegationLines.tsx';
import { buildDelegationTree } from '../tree/model.ts';
import { useNow } from '../../components/RelativeTime.tsx';
import { Icon } from '../../components/Icon.tsx';
import '../../components/activity.css';

const PROJECT_PAGE_SIZE = 20;
const FOLD_PAGE_SIZE = 50;

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

function Counts({ running, waiting, language }: { running: number; waiting: number; language: Language }) {
  const ja = language === 'ja';
  if (!running && !waiting) return null;
  return <span className="section-counts">
    {running > 0 && <span className="section-count is-running"><strong className="numeric">{running}</strong> {ja ? '実行中' : 'running'}</span>}
    {waiting > 0 && <span className="section-count is-waiting"><strong className="numeric">{waiting}</strong> {ja ? '待ち' : 'waiting'}</span>}
  </span>;
}

function WorkRows({ items, now, language, actions }: { items: WorkItem[]; now: number; language: Language; actions?: (item: Activity) => ReactNode }) {
  const delegations = new Map(items.map(item => [item.activity.id, item.delegations]));
  return <div className="table" role="presentation"><TableHead language={language}/>
    {orderActivities(items.map(item => item.activity)).map(activity => {
      const lines = delegations.get(activity.id) ?? [];
      return <ActivityRow key={activity.id} activity={activity} now={now} language={language} actions={actions?.(activity)}>
        {lines.length > 0 ? <DelegationFold lines={lines} language={language}/> : undefined}
      </ActivityRow>;
    })}</div>;
}

function ProjectSection({ group, state, now, language, filtered }: {
  group: ProjectGroup; state: ScreenState; now: number; language: Language; filtered: boolean;
}) {
  const ja = language === 'ja';
  const [limit, setLimit] = useState(PROJECT_PAGE_SIZE);
  const name = getProjectName(state, group.id);
  // 動いているものと待ちは常に出し、止まっているものは新しい順に区切って出す。
  const active = group.items.filter(item => item.active).length;
  const shown = group.items.slice(0, Math.max(limit, active));
  const rest = group.items.length - shown.length;
  return <section className="activity-group project-section" aria-label={name}>
    <header className="section-header project-section-header">
      <h2><Link className="project-heading" to={`/p/${encodeURIComponent(group.id)}`}><Icon name="folder" size={15}/><span className="project-name truncate">{name}</span></Link>
        <span className="count-pill">{group.items.length}</span></h2>
      <Counts running={group.running} waiting={group.waiting} language={language}/>
      <span className="spacer"/>
      {group.id !== OTHER_PROJECT && <Link className="btn btn-ghost btn-sm" to={`/p/${encodeURIComponent(group.id)}?create=1`}><Icon name="plus" size={14}/>{ja ? '作業を作る' : 'Create task'}</Link>}
    </header>
    {shown.length > 0 && <div className="table-group"><WorkRows items={shown} now={now} language={language}/></div>}
    {rest > 0 && <button className="btn btn-secondary btn-sm show-more" onClick={() => setLimit(value => value + FOLD_PAGE_SIZE)}>
      {ja ? `止まっている作業をさらに ${Math.min(FOLD_PAGE_SIZE, rest)} 件表示` : `Show ${Math.min(FOLD_PAGE_SIZE, rest)} more stopped tasks`}</button>}
    {group.unlinked.length > 0 && <div className="unlinked-delegations">
      <DelegationFold lines={group.unlinked} language={language}
        label={ja ? '親が未確定の委譲' : `${countAllDelegations(group.unlinked) === 1 ? 'delegation' : 'delegations'} without a confirmed parent`}/>
    </div>}
    {!group.items.length && !group.unlinked.length && <p className="empty-row">{filtered ? (ja ? '該当する作業はありません' : 'No matching activity') : (ja ? 'まだありません' : 'Nothing here yet')}</p>}
  </section>;
}

/** 外の会話と無人実行は、既定で畳んで件数だけを見せる。開いたときだけ行を描く。 */
function FoldSection({ title, description, items, now, language, actions }: {
  title: string; description: string; items: WorkItem[]; now: number; language: Language; actions?: (item: Activity) => ReactNode;
}) {
  const ja = language === 'ja';
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(FOLD_PAGE_SIZE);
  const running = items.filter(item => ['starting', 'running'].includes(item.activity.state)).length
    + items.reduce((total, item) => total + countActiveDelegations(item.delegations), 0);
  const waiting = items.filter(item => ['waiting_approval', 'waiting_input'].includes(item.activity.state)).length;
  const id = useId();
  return <section className={`activity-group fold-section${open ? ' is-open' : ''}`} aria-label={title}>
    <header className="section-header fold-header">
      <h2><button className="fold-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14}/>{title}</button><span className="count-pill">{items.length}</span></h2>
      <Counts running={running} waiting={waiting} language={language}/>
      <p>{description}</p>
    </header>
    <div id={id} hidden={!open}>
      {open && <>
        {items.length > 0 ? <div className="table-group"><WorkRows items={items.slice(0, limit)} now={now} language={language} actions={actions}/></div>
          : <p className="empty-row">{ja ? 'まだありません' : 'Nothing here yet'}</p>}
        {items.length > limit && <button className="btn btn-secondary btn-sm show-more" onClick={() => setLimit(value => value + FOLD_PAGE_SIZE)}>
          {ja ? `さらに ${Math.min(FOLD_PAGE_SIZE, items.length - limit)} 件を表示` : `Show ${Math.min(FOLD_PAGE_SIZE, items.length - limit)} more`}</button>}
      </>}
    </div>
  </section>;
}

export function HomePage({ target = store, client, language = 'en' }: { target?: ScreenStore; client?: ConversationClient; language?: Language }) {
  const state = useScreenStore(target);
  const now = useNow();
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [project, setProject] = useState('');
  const [showTemporary, setShowTemporary] = useState(false);
  const all = useMemo(() => selectActivities(state), [state]);
  const tree = useMemo(() => buildDelegationTree(state), [state]);
  const activities = useMemo(() => all.filter(item => showTemporary || !item.temporary), [all, showTemporary]);
  const overview = useMemo(() => buildOverview(state, activities.filter(item => (!status || item.state === status)
    && (!provider || item.provider === provider) && (!project || item.project === project)), tree),
  [state, tree, activities, status, provider, project]);
  const projects = [...getRegisteredProjects(state).map(row => String(row.id)), OTHER_PROJECT];
  const visible = [...overview.projects.flatMap(group => group.items.slice(0, PROJECT_PAGE_SIZE)), ...overview.external.slice(0, FOLD_PAGE_SIZE)].map(item => item.activity);
  useProvisionalNames(state, target, visible, client);
  const ja = language === 'ja';
  const filtered = Boolean(status || provider || project);
  const count = (states: string[]) => activities.filter(item => states.includes(item.state)).length;
  const summary = [[count(['starting', 'running']), ja ? '実行中' : 'running'], [count(['waiting_approval', 'waiting_input']), ja ? '待ち' : 'waiting'],
    [count(['unknown']), ja ? '不明' : 'unknown']] as const;
  const conversationActions = (item: Activity) => item.conversationId && <>
    {item.section === 'external' && <Link className="btn btn-secondary btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}?adopt=1`}>{ja ? '引き継ぐ' : 'Take over'}</Link>}
    {item.state === 'unknown' ? <Link className="btn btn-ghost btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '根拠を確認' : 'Review evidence'}</Link>
      : <Link className="btn btn-ghost btn-sm" to={`/c/${encodeURIComponent(item.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</Link>}
  </>;
  return <div className="page">
    <header className="page-header"><div className="page-title"><h1>{ja ? '一覧' : 'Overview'}</h1>
      <p className="page-subtitle">{summary.map(([value, label]) => <span key={label}><strong className="numeric">{value}</strong> {label}</span>)}</p></div></header>
    <div className="toolbar" role="group" aria-label={ja ? '絞り込み' : 'Filters'}>
      <Icon name="filter" size={14} className="toolbar-icon"/>
      <label className="inline-field">{ja ? '状態' : 'State'}<select value={status} onChange={event => setStatus(event.target.value)}><option value="">{ja ? 'すべての状態' : 'All states'}</option>{executionStates.map(value => <option key={value} value={value}>{value === 'starting' ? (ja ? '起動中' : 'Starting') : dictionaries[language][value]}</option>)}</select></label>
      <label className="inline-field">Provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="">{ja ? 'すべて' : 'All providers'}</option>{[...new Set(activities.map(item => item.provider))].filter(Boolean).sort().map(value => <option key={value} value={value}>{providerName(value)}</option>)}</select></label>
      <label className="inline-field">{ja ? 'プロジェクト' : 'Project'}<select value={project} onChange={event => setProject(event.target.value)}><option value="">{ja ? 'すべてのプロジェクト' : 'All projects'}</option>{projects.filter(Boolean).map(value => <option key={value} value={value} title={getProjectName(state, value)}>{getProjectName(state, value)}</option>)}</select></label>
      <label className="inline-field"><input type="checkbox" checked={showTemporary} onChange={event => setShowTemporary(event.target.checked)}/>Show temporary</label>
      <button className="btn btn-ghost btn-sm" disabled={!filtered} onClick={() => { setStatus(''); setProvider(''); setProject(''); }}>{ja ? '解除' : 'Clear filters'}</button>
    </div>
    {overview.projects.map(group => <ProjectSection key={group.id} group={group} state={state} now={now} language={language} filtered={filtered}/>)}
    {!overview.projects.length && <section className="activity-group" aria-label={ja ? 'プロジェクト' : 'Projects'}>
      <p className="empty-row">{filtered ? (ja ? '該当する作業はありません' : 'No matching activity') : (ja ? '作業はまだありません' : 'No tasks yet')}</p></section>}
    <FoldSection title={ja ? '外の会話' : 'External conversations'} description={ja ? '外のターミナルで始まった会話。引き継ぐまで読み取り専用' : 'Observed from other terminals; read-only until taken over'}
      items={overview.external} now={now} language={language} actions={conversationActions}/>
    <FoldSection title={ja ? '無人実行' : 'Unattended runs'} description={ja ? '名前のない自動の実行' : 'Automated runs without a conversation name'}
      items={overview.unattended} now={now} language={language} actions={conversationActions}/>
    <FoldSection title={ja ? '形式未対応の会話' : 'Unsupported conversations'} description={ja ? '履歴の形式に未対応' : 'History format not supported yet'}
      items={overview.unsupported} now={now} language={language} actions={conversationActions}/>
  </div>;
}
export default HomePage;
