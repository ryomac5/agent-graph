import { compareMessages } from '../../lib/projection-client.ts';
import { useEffect, useRef, useState } from 'react';
import { AppLink } from '../../components/AppLink.tsx';
import { StateBadge, type ExecutionState } from '../../components/StateBadge.tsx';
import { ApprovalRequestView, OutcomeChip } from '../../components/ApprovalRequest.tsx';
import { Icon } from '../../components/Icon.tsx';
import { executionStates, readBody } from '../../components/activity.ts';
import { approvalReasonText, evidenceLabel, formatSeconds, projectLabel, readApprovalRequest, runLabel } from '../../lib/format.ts';
import { store, useScreenStore, type Row, type ScreenState, type ScreenStore } from '../../lib/store.ts';
import { answerApproval, APPROVAL_KEYS, getConversation, getDecision, getInbox, getRequestedTime, isPending, readText,
  type ApprovalAction, type CommandClient } from './model.ts';
import './inbox.css';

export interface InboxProps { client: CommandClient; target?: ScreenStore }
const TAIL_LIMIT = 5;
const CLOCK_INTERVAL_MS = 1_000;
const ACTION_LABELS = { allow: 'Allow', deny: 'Deny', session: 'Always allow' };
// 行の操作は従のボタンにし、主のボタンはまとめての許可の 1 つに限る。
const ACTION_STYLES = { allow: 'btn-secondary btn-allow', deny: 'btn-secondary', session: 'btn-ghost' };
const ACTION_ICONS = { allow: 'check', deny: 'x', session: 'check' } as const;
function ActionButtons({ row, disabled, onAnswer, small = true }: { row: Row; disabled: boolean; onAnswer: (action: ApprovalAction) => void; small?: boolean }) {
  return <>{(Object.keys(ACTION_LABELS) as ApprovalAction[]).map(action => <button key={action}
    className={`btn ${ACTION_STYLES[action]}${small ? ' btn-sm' : ''}`}
    disabled={disabled || !getDecision(row, action)} title={!getDecision(row, action) ? 'Not offered by this provider' : `${ACTION_LABELS[action]} (${APPROVAL_KEYS[action].toUpperCase()})`}
    onClick={() => onAnswer(action)}>{action !== 'session' && <Icon name={ACTION_ICONS[action]} size={14}/>}{ACTION_LABELS[action]}</button>)}</>;
}
export function ApprovalActions({ row, client, disabled = false }: { row: Row; client: CommandClient; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function answer(action: ApprovalAction) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await answerApproval(client, row, action); setAnswered(true); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); lock.current = false; }
    finally { setBusy(false); }
  }
  return <div className="approval-actions">
    <div className="button-row"><ActionButtons row={row} disabled={disabled || busy || answered || !isPending(row)} onAnswer={action => void answer(action)}/></div>
    {answered && <p role="status" className="status-line">Sent</p>}
    {error && <p role="alert" className="status-line danger">{error}</p>}
  </div>;
}
function ConversationTail({ row, state }: { row: Row; state: ScreenState }) {
  const conversation = getConversation(row, state);
  const memberships = new Set((state.projection.message_memberships ?? [])
    .filter(link => link.conversation_id === conversation && link.active === 1).map(link => link.message_id));
  const messages = (state.projection.messages ?? []).filter(message => memberships.has(message.id))
    .sort(compareMessages)
    .slice(-TAIL_LIMIT);
  const deltas = Object.values(state.deltas).filter(delta => delta.runId === row.run_id);
  return <details className="disclosure"><summary><Icon name="chevronRight" size={12} className="caret"/>Recent messages</summary>
    <div className="tail">
      {messages.length === 0 && deltas.length === 0 && <p className="muted-text">No conversation content available.</p>}
      {messages.map(message => <div className="tail-message" key={String(message.id)}><span className="tail-role">{readText(message.role) === 'user' ? 'User' : 'Agent'}</span>
        <p>{message.body_state === 'stored' ? readBody(message.body) : `Content unavailable: ${readText(message.body_state)}`}</p></div>)}
      {deltas.map((delta, index) => <div className="tail-message" key={index}><span className="tail-role">Streaming</span><p>{delta.text}</p></div>)}
    </div>
  </details>;
}
export function ApprovalContext({ row, state }: { row: Row; state: ScreenState }) {
  const run = state.projection.runs?.find(run => run.id === row.run_id);
  const conversationId = getConversation(row, state);
  const conversation = state.projection.conversations?.find(item => item.id === conversationId);
  const project = readText(state.projection.tasks?.find(task => task.id === conversation?.task_id)?.project);
  const status = executionStates.includes(run?.state as ExecutionState) ? run!.state as ExecutionState : 'unknown';
  return <div className="approval-context">
    <AppLink className="run-link truncate" to={`/c/${encodeURIComponent(conversationId)}`} title="Open the conversation">{runLabel(state, row.run_id)}</AppLink>
    {project && <span className="context-project truncate" title={project}><Icon name="folder" size={13}/>{projectLabel(project).name}</span>}
    <StateBadge state={status} evidenceUrl={`/c/${encodeURIComponent(conversationId)}`}
      evidence={evidenceLabel(status === 'ended' ? run?.end_evidence : run?.last_evidence) || undefined}
      evidenceTime={run?.last_evidence_ts ? <time dateTime={readText(run.last_evidence_ts)}>{readText(run.last_evidence_ts)}</time> : undefined}
      reason={readText(run?.cause ?? run?.reason) || undefined}/>
  </div>;
}
export function ApprovalDetails({ row, state, compact = false }: { row: Row; state: ScreenState; compact?: boolean }) {
  const request = readApprovalRequest(row.request);
  return <div className="approval-details">
    <div className="approval-heading"><span className="tool-name">{request.tool}</span>{request.summary && <span className="approval-summary truncate">{request.summary}</span>}</div>
    <ApprovalContext row={row} state={state}/>
    <ApprovalRequestView request={row.request} compact={compact}/>
    <ConversationTail row={row} state={state}/>
  </div>;
}
export function Inbox({ client, target = store }: InboxProps) {
  const state = useScreenStore(target);
  const { pending, expired } = getInbox(state);
  const [selected, setSelected] = useState<string[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const active = pending.filter(row => selected.includes(String(row.id)) && !sent.includes(String(row.id)));
  const open = pending.filter(row => !sent.includes(String(row.id)));
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS); return () => clearInterval(timer); }, []);
  async function answer(rows: Row[], action: ApprovalAction) {
    if (lock.current || !rows.length || rows.some(row => !getDecision(row, action))) return;
    lock.current = true; setBusy(true); setError('');
    const results = await Promise.allSettled(rows.map(row => answerApproval(client, row, action)));
    const successful = rows.filter((_, index) => results[index].status === 'fulfilled').map(row => String(row.id));
    setSent(previous => [...previous, ...successful]);
    setSelected(previous => previous.filter(id => !successful.includes(id)));
    setError(results.flatMap((result, index) => result.status === 'rejected' ? [`${runLabel(state, rows[index].run_id)}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []).join('\n'));
    lock.current = false; setBusy(false);
  }
  async function resume(row: Row) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const ack = await client.command('resume', { conversationId: getConversation(row, state), input: { text: 'Continue from where you stopped.' } });
      if (!ack.ok) throw new Error(ack.error ?? 'Resume failed.');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="page inbox-page" aria-label="Approvals" onKeyDown={event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable="true"]')))) return;
    const action = (Object.keys(APPROVAL_KEYS) as ApprovalAction[]).find(action => APPROVAL_KEYS[action] === event.key.toLowerCase());
    if (!action) return;
    const focused = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-approval-id]')?.dataset.approvalId : undefined;
    const rows = active.length ? active : pending.filter(row => String(row.id) === focused && !sent.includes(String(row.id)));
    if (rows.length) { event.preventDefault(); void answer(rows, action); }
  }}>
    <header className="page-header"><div className="page-title"><h1>Approvals</h1>
      <p role="status" className="page-subtitle">{pending.length > 0 && <span><strong className="numeric">{pending.length}</strong> waiting</span>}{expired.length > 0 && <span><strong className="numeric">{expired.length}</strong> expired</span>}</p></div>
      {pending.length > 0 && <p className="shortcut-hint"><kbd>A</kbd> allow <kbd>D</kbd> deny <kbd>S</kbd> allow for this conversation</p>}</header>
    {pending.length > 0 && <div className="toolbar bulk-bar">
      <label className="checkbox"><input type="checkbox" disabled={busy || pending.length === 0}
        checked={open.length > 0 && open.every(row => selected.includes(String(row.id)))}
        onChange={event => setSelected(event.target.checked ? open.map(row => String(row.id)) : [])}/>Select all pending</label>
      <span className="muted-text numeric">{active.length} selected</span><span className="spacer"/>
      <div className="button-row" role="group" aria-label="Bulk answers">{(Object.keys(ACTION_LABELS) as ApprovalAction[]).map(action => <button key={action}
        className={`btn btn-sm ${action === 'allow' ? 'btn-primary' : ACTION_STYLES[action]}`}
        disabled={busy || !active.length || active.some(row => !getDecision(row, action))}
        onClick={() => void answer(active, action)}>{ACTION_LABELS[action]} selected</button>)}</div>
    </div>}
    {error && <p role="alert" className="banner banner-danger"><Icon name="alert" size={14}/>{error}</p>}
    <ol aria-label="Pending approvals" className="approval-list">{pending.map(row => {
      const id = String(row.id);
      const timestamp = getRequestedTime(row, state);
      const elapsed = Date.parse(timestamp);
      return <li key={id} data-approval-id={id} tabIndex={0} className={`approval-row${selected.includes(id) ? ' selected' : ''}${sent.includes(id) ? ' sent' : ''}`}>
        <input type="checkbox" className="row-check" aria-label={`Select ${id}`} disabled={busy || sent.includes(id)} checked={selected.includes(id)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))}/>
        <div className="approval-main"><ApprovalDetails row={row} state={state}/></div>
        <div className="approval-side">
          <span className="wait" title={timestamp || undefined}><Icon name="clock" size={13}/>{Number.isFinite(elapsed) ? `Waiting ${formatSeconds(Math.max(0, Math.floor((now - elapsed) / 1000)))}` : 'Waiting'}</span>
          {timestamp && <time className="sr-only" dateTime={timestamp}>{timestamp}</time>}
          <div className="button-row vertical"><ActionButtons row={row} disabled={busy || sent.includes(id)} onAnswer={action => void answer([row], action)}/></div>
          {sent.includes(id) && <p className="status-line">Sent</p>}
        </div>
      </li>;
    })}</ol>
    {pending.length === 0 && <div className="empty-state"><Icon name="check" size={22}/><h2>Nothing to approve</h2><p>When an agent asks for permission, it shows up here.</p></div>}
    {expired.length > 0 && <section className="expired-section" aria-label="Expired"><h2>Expired</h2><ol aria-label="Expired approvals" className="approval-list">{expired.map(row => <li key={String(row.id)} className="approval-row expired">
      <OutcomeChip row={row}/>
      <div className="approval-main"><ApprovalDetails row={row} state={state}/>{approvalReasonText(readText(row.reason)) && <p className="muted-text">{approvalReasonText(readText(row.reason))}</p>}</div>
      <div className="approval-side"><button className="btn btn-secondary btn-sm" disabled={busy || !getConversation(row, state)} onClick={() => void resume(row)}><Icon name="play" size={13}/>Resume</button></div>
    </li>)}</ol></section>}
  </section>;
}
export default Inbox;
