import { useProvisionalNames } from '../../lib/provisional-names.ts';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { getProjectName, resolveProjectId } from '../../lib/projects.ts';
import { ActivityRow, providerName } from '../../components/ActivityRow.tsx';
import { readBody, readText, selectActivities, orderActivities, summarizeChanges } from '../../components/activity.ts';
import { CreateTaskForm, type CommandClient } from '../../components/CreateTaskForm.tsx';
import { RelativeTime, useNow } from '../../components/RelativeTime.tsx';
import { Icon } from '../../components/Icon.tsx';
import { FileNotices, FileTreePanel, FileViewerPanel, useFileExplorer } from '../files/FilesPage.tsx';
import '../../components/activity.css';
import '../files/files.css';

const TASK_PAGE_SIZE = 50;
const ACTIVE = ['starting', 'running', 'waiting_approval', 'waiting_input'];
/** この幅以下では、Files の列を既定で畳む。 */
export const FILES_COLLAPSE_WIDTH = 1024;
function readWideScreen(): boolean { return typeof window === 'undefined' || window.innerWidth > FILES_COLLAPSE_WIDTH; }

export function WorkspacePage({ project: suppliedProject, target = store, client, language = 'en', renderConversation }: {
  project?: string; target?: ScreenStore; client: CommandClient; language?: Language; renderConversation?: (conversationId: string) => ReactNode;
}) {
  const params = useParams();
  const [search] = useSearchParams();
  const route = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  // 経路のプロジェクトは表示名でも識別子でも受け、投影の projects の識別子に揃えてから絞る。
  const project = resolveProjectId(state, route);
  const now = useNow();
  const ja = language === 'ja';
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(search.get('create') === '1');
  const [order, setOrder] = useState('name');
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [showTemporary, setShowTemporary] = useState(false);
  const [limit, setLimit] = useState(TASK_PAGE_SIZE);
  // 左の列には Files の木を常に置く。狭い画面では既定で畳み、ファイルを指す経路では開いて出す。
  const [filesOpen, setFilesOpen] = useState(() => search.has('path') || readWideScreen());
  const explorer = useFileExplorer({ client, target, project: route, enabled: filesOpen || search.has('path') });
  const allItems = selectActivities(state, true).filter(item => item.project === project && (showTemporary || !item.temporary)).sort((a, b) =>
    order === 'state' ? a.state.localeCompare(b.state) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  const items = allItems.slice(0, limit);
  useProvisionalNames(state, target, items, client);
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  const available = state.connection === 'connected';
  const activeCount = items.filter(item => ACTIVE.includes(item.state)).length;
  const label = { name: getProjectName(state, project), full: getProjectName(state, project), detail: '' };
  const allocations = [...new Set(items.filter(item => item.provider || item.model).map(item => [providerName(item.provider), item.model].filter(Boolean).join(' · ')))];
  const changes = summarizeChanges(selected?.artifacts ?? []);
  const prefix = `/p/${encodeURIComponent(route)}`;
  async function stop(runId: string) {
    if (!available || pending.includes(runId)) return;
    setPending(ids => [...ids, runId]); setError('');
    try {
      const ack = await client.command('interrupt', { runId });
      if (!ack.ok) setError(ack.error ?? 'Command rejected');
    } catch (cause) { setError(String(cause)); }
    finally { setPending(ids => ids.filter(id => id !== runId)); }
  }
  const conversation = selected?.conversationId && renderConversation ? renderConversation(selected.conversationId) : <div className="column-scroll fallback-conversation">
    <h2>{selected?.name ?? (ja ? '会話' : 'Conversation')}</h2>
    {selected?.messages.map(message => <article className="message" key={readText(message.id)}><div className="message-main"><strong>{readText(message.role)}</strong><p>{readBody(message.body) || readText(message.body_state) || (ja ? '本文を取得できません' : 'Body unavailable')}</p></div></article>)}
    {selected && Object.entries(state.deltas).filter(([, delta]) => delta.runId === selected.id || selected.conversationId && delta.conversationId === selected.conversationId).map(([id, delta]) => <article key={id} aria-label="Streaming response">{delta.text}</article>)}
    {!selected?.messages.length && <p className="empty-row">{ja ? '発言はまだありません' : 'No messages yet'}</p>}
    {selected?.conversationId && <Link className="btn btn-link btn-sm" to={`/c/${encodeURIComponent(selected.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</Link>}
  </div>;
  return <div className={`workspace${filesOpen ? ' files-open' : ' files-collapsed'}`}>
    <label className="inline-field"><input type="checkbox" checked={showTemporary} onChange={event => setShowTemporary(event.target.checked)}/>Show temporary</label>
    {allItems.length > limit && <button className="btn" onClick={() => setLimit(value => value + TASK_PAGE_SIZE)}>Load more tasks</button>}
    <header className="workspace-header">
      <div className="page-title"><p className="eyebrow">{ja ? 'プロジェクトの作業場' : 'Project workspace'}</p>
        <h1 className="truncate" title={label.full}><Icon name="folder" size={18}/>{label.name}</h1>
        {label.detail && <p className="project-path truncate" title={label.full}>{label.detail}</p>}</div>
      <dl className="workspace-stats">
        <div><dt>{ja ? '割り当て' : 'Allocation'}</dt><dd>{allocations.length ? allocations.map(value => <span key={value} className="chip chip-quiet">{value}</span>)
          : <span className="muted-text">{ja ? '記録なし' : 'None recorded'}</span>}</dd></div>
        <div><dt>{ja ? '利用枠' : 'Quota'}</dt><dd><span className="muted-text" title={ja ? 'provider から利用枠の報告がありません' : 'Providers have not reported usage limits'}>{ja ? '報告なし' : 'Not reported'}</span></dd></div>
        <div><dt>{ja ? '実行中' : 'Active'}</dt><dd className="numeric">{activeCount} {ja ? '件' : activeCount === 1 ? 'run' : 'runs'}</dd></div>
      </dl>
      <div className="workspace-actions">
        <label className="inline-field">{ja ? '並べ替え' : 'Sort tasks'}<select className="select-sm" value={order} onChange={event => setOrder(event.target.value)}><option value="name">{ja ? '名前' : 'Name'}</option><option value="state">{ja ? '状態' : 'State'}</option></select></label>
        <button className="btn btn-sm btn-secondary" onClick={() => setCreating(value => !value)} aria-expanded={creating}><Icon name="plus" size={14}/>{ja ? '作業を作る' : 'Create task'}</button>
      </div>
    </header>
    {(!available || error || creating) && <div className="workspace-notices">
      {!available && <p role="status" className="banner"><Icon name="unknown" size={14}/>{ja ? '接続後に操作できます' : 'Controls are available when connected to the runner.'}</p>}
      {error && <p role="alert" className="banner banner-danger"><Icon name="alert" size={14}/>{error}</p>}
      {creating && <CreateTaskForm key={project} project={project} root={readText(state.projection.projects?.find(row => row.id === project)?.root_path)}
        client={client} disabled={!available || !project} language={language} onCancel={() => setCreating(false)}/>}
    </div>}
    <nav className="tabs" aria-label={ja ? 'プロジェクト' : 'Project'}>
      <Link to={prefix} aria-current="page">{ja ? 'プロジェクト' : 'Project'}</Link>
      <Link to={`${prefix}/tree`}>{ja ? '委譲' : 'Tree'}</Link>
      <Link to={`${prefix}/changes`}>Changes</Link>
    </nav>
    <div className="workspace-columns">
      <aside className="workspace-files" aria-label={ja ? 'ファイルの列' : 'Files column'}>
        {filesOpen ? <>
          <FileTreePanel explorer={explorer} actions={<button className="icon-button" aria-label={ja ? 'ファイルの列を畳む' : 'Hide files'} title={ja ? 'ファイルの列を畳む' : 'Hide files'}
            onClick={() => setFilesOpen(false)}><Icon name="chevronLeft" size={14}/></button>}/>
          <FileNotices explorer={explorer}/>
        </> : <button className="files-rail" aria-label={ja ? 'ファイルの列を開く' : 'Show files'} title={ja ? 'ファイルの列を開く' : 'Show files'} onClick={() => setFilesOpen(true)}>
          <Icon name="chevronRight" size={14}/><span className="files-rail-label" aria-hidden="true">Files</span></button>}
      </aside>
      <div className="workspace-center">
        <section className="workspace-tasks" aria-label={ja ? '作業' : 'Tasks'}>
          <header className="column-header"><h2>{ja ? '作業' : 'Tasks'}</h2><span className="count-pill">{items.length}</span></header>
          <div className="column-scroll">
            {orderActivities(items).map(item => <ActivityRow key={item.id} variant="list" selected={item.id === selected?.id && !explorer.selectedPath} activity={item} now={now} language={language}
              onSelect={() => { setSelectedId(item.id); if (explorer.selectedPath) explorer.closeFile(); }}
              actions={item.run && item.managed && [...ACTIVE, 'idle', 'unknown'].includes(item.state)
                ? <button className="btn btn-ghost btn-xs" aria-label={pending.includes(item.id) ? (ja ? '停止要求中' : 'Stop requested') : (ja ? '実行を停止' : 'Stop run')}
                  title={ja ? '実行を停止' : 'Stop run'} disabled={!available || pending.includes(item.id)} onClick={() => void stop(item.id)}><Icon name="stop" size={12}/>{ja ? '停止' : 'Stop'}</button> : undefined}/>)}
            {!items.length && <p className="empty-row">{ja ? '作業はまだありません' : 'No tasks yet'}</p>}
          </div>
        </section>
        <section className="workspace-conversation" aria-label={ja ? '会話' : 'Conversation'}>
        {explorer.selectedPath ? <FileViewerPanel explorer={explorer} actions={<button className="btn btn-ghost btn-xs" onClick={explorer.closeFile}>
          <Icon name="x" size={12}/>{ja ? '会話に戻る' : 'Back to conversation'}</button>}/> : <>
          {selected?.state === 'unknown' && <div className="banner banner-unknown"><Icon name="unknown" size={14}/>{ja ? '不明 — 最後の根拠' : 'Unknown — Last evidence'}: <RelativeTime value={readText(selected.run?.last_evidence_ts)} now={now} language={language}/>
            {selected.conversationId && <Link className="btn btn-link btn-sm" to={`/c/${encodeURIComponent(selected.conversationId)}`}>{ja ? '根拠を確認' : 'Review evidence'}</Link>}</div>}
          {conversation}
        </>}
        </section>
      </div>
      <aside className="workspace-changes" aria-label="Changes">
        <header className="column-header"><h2>Changes</h2></header>
        <div className="column-scroll">
          {changes ? <p className="numeric">{changes}</p> : <div className="empty-mini"><Icon name="diff" size={18}/><p>{ja ? '成果物はまだありません' : 'No artifact yet'}</p>
            <p className="muted-text">{ja ? '実行が成果を確定すると、差分の概要がここに出ます。' : 'A diff summary appears here once the run records an artifact.'}</p></div>}
          <Link className="btn btn-secondary btn-sm" to={`${prefix}/changes${selected?.run ? `?run=${encodeURIComponent(selected.id)}` : ''}`}><Icon name="diff" size={14}/>{ja ? '変更を開く' : 'Open Changes'}</Link>
        </div>
      </aside>
    </div>
  </div>;
}
export default WorkspacePage;
