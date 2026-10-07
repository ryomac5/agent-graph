import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { ActivityRow } from '../../components/ActivityRow.tsx';
import { readBody, readText, selectActivities, summarizeChanges } from '../../components/activity.ts';
import { CreateTaskForm, type CommandClient } from '../../components/CreateTaskForm.tsx';
import { RelativeTime, useNow } from '../../components/RelativeTime.tsx';
import '../../components/activity.css';

export function WorkspacePage({ project: suppliedProject, target = store, client, language = 'en', renderConversation }: {
  project?: string; target?: ScreenStore; client: CommandClient; language?: Language; renderConversation?: (conversationId: string) => ReactNode;
}) {
  const params = useParams();
  const [search] = useSearchParams();
  const project = suppliedProject ?? params.project ?? '';
  const state = useScreenStore(target);
  const now = useNow();
  const ja = language === 'ja';
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(search.get('create') === '1');
  const [order, setOrder] = useState('name');
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState('');
  const items = selectActivities(state, true).filter(item => item.project === project).sort((a, b) =>
    order === 'state' ? a.state.localeCompare(b.state) || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  const available = state.connection === 'connected';
  const activeCount = items.filter(item => ['starting', 'running', 'waiting_approval', 'waiting_input'].includes(item.state)).length;
  async function stop(runId: string) {
    if (!available || pending.includes(runId)) return;
    setPending(ids => [...ids, runId]); setError('');
    try {
      const ack = await client.command('interrupt', { runId });
      if (!ack.ok) setError(ack.error ?? 'Command rejected');
    } catch (cause) { setError(String(cause)); }
    finally { setPending(ids => ids.filter(id => id !== runId)); }
  }
  return <section><div className="page-heading"><h1>{ja ? 'プロジェクトの作業場' : 'Project workspace'}</h1><p>{project}</p></div>
    <div className="project-allocation"><span>{ja ? '割り当て' : 'Allocation'}: {[...new Set(items.map(item => `${item.provider} · ${item.model}`))].join(', ') || (ja ? '不明' : 'Unknown')}</span>
      <span>{ja ? '利用枠' : 'Quota'}: {ja ? '不明' : 'Unknown'}</span><span>{activeCount} {ja ? '実行中' : 'active runs'}</span></div>
    <div className="activity-toolbar"><button onClick={() => setCreating(value => !value)} aria-expanded={creating}>{ja ? '作業を作る' : 'Create task'}</button>
      <label>{ja ? '並べ替え' : 'Sort tasks'} <select value={order} onChange={event => setOrder(event.target.value)}><option value="name">{ja ? '名前' : 'Name'}</option><option value="state">{ja ? '状態' : 'State'}</option></select></label></div>
    {!available && <p role="status">{ja ? '接続後に操作できます' : 'Controls are available when connected to the runner.'}</p>}
    {creating && <CreateTaskForm key={project} project={project} client={client} disabled={!available || !project} language={language}/>}
    {error && <p role="alert">{error}</p>}
    <div className="workspace-columns"><section aria-label={ja ? '作業' : 'Tasks'}><h2>{ja ? '作業' : 'Tasks'}</h2>
      {items.map(item => <ActivityRow key={item.id} activity={item} now={now} language={language} onSelect={() => setSelectedId(item.id)}
        actions={item.run && item.managed && ['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'unknown'].includes(item.state)
          ? <button disabled={!available || pending.includes(item.id)} onClick={() => void stop(item.id)}>{pending.includes(item.id) ? (ja ? '停止要求中' : 'Stop requested') : (ja ? '実行を停止' : 'Stop run')}</button> : undefined}/>)}
      {!items.length && <p>{ja ? '作業はまだありません' : 'No tasks yet'}</p>}</section>
      <section className="workspace-conversation" aria-label={ja ? '会話' : 'Conversation'}><h2>{selected?.name ?? (ja ? '会話' : 'Conversation')}</h2>
        {selected?.state === 'unknown' && <div className="unknown-evidence">{ja ? '不明 — 最後の根拠' : 'Unknown — Last evidence'}: <RelativeTime value={readText(selected.run?.last_evidence_ts)} now={now} language={language}/>
          {selected.conversationId && <Link to={`/c/${encodeURIComponent(selected.conversationId)}`}>{ja ? '根拠を確認' : 'Review evidence'}</Link>}</div>}
        {selected?.conversationId && renderConversation ? renderConversation(selected.conversationId) : <>
          {selected?.messages.map(message => <article key={readText(message.id)}><strong>{readText(message.role)}</strong><p>{readBody(message.body) || readText(message.body_state) || (ja ? '本文を取得できません' : 'Body unavailable')}</p></article>)}
          {selected && Object.entries(state.deltas).filter(([, delta]) => delta.runId === selected.id || selected.conversationId && delta.conversationId === selected.conversationId).map(([id, delta]) => <article key={id} aria-label="Streaming response">{delta.text}</article>)}
          {!selected?.messages.length && <p>{ja ? '発言はまだありません' : 'No messages yet'}</p>}
          {selected?.conversationId && <Link to={`/c/${encodeURIComponent(selected.conversationId)}`}>{ja ? '会話を開く' : 'Open conversation'}</Link>}
        </>}
      </section><aside className="changes-summary" aria-label="Changes"><h2>Changes</h2><p>{summarizeChanges(selected?.artifacts ?? [])}</p>
        <Link to={`/p/${encodeURIComponent(project)}/changes`}>{ja ? '変更を開く' : 'Open Changes'}</Link></aside></div>
  </section>;
}
export default WorkspacePage;
