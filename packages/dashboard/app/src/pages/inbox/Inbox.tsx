import { useEffect, useRef, useState } from 'react';
import { AppLink } from '../../components/AppLink.tsx';
import { StateBadge, type ExecutionState } from '../../components/StateBadge.tsx';
import { executionStates, readBody, readObject } from '../../components/activity.ts';
import { store, useScreenStore, type Row, type ScreenState, type ScreenStore } from '../../lib/store.ts';
import { answerApproval, APPROVAL_KEYS, getConversation, getDecision, getInbox, getRequestedTime, isPending, readText,
  type ApprovalAction, type CommandClient } from './model.ts';

export interface InboxProps { client: CommandClient; target?: ScreenStore }
const TAIL_LIMIT = 5;
const CLOCK_INTERVAL_MS = 1_000;
const ACTION_LABELS = { allow: 'Allow', deny: 'Deny', session: 'Allow for this conversation' };
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
  return <div>
    {(Object.keys(ACTION_LABELS) as ApprovalAction[]).map(action => <button key={action}
      disabled={disabled || busy || answered || !isPending(row) || !getDecision(row, action)}
      title={!getDecision(row, action) ? 'Not offered by this provider' : undefined}
      onClick={() => void answer(action)}>{ACTION_LABELS[action]}</button>)}
    {answered && <p role="status">Answer sent; waiting for resolution.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
function ConversationTail({ row, state }: { row: Row; state: ScreenState }) {
  const conversation = getConversation(row, state);
  const memberships = new Set((state.projection.message_memberships ?? [])
    .filter(link => link.conversation_id === conversation && link.active === 1).map(link => link.message_id));
  const messages = (state.projection.messages ?? []).filter(message => memberships.has(message.id))
    .sort((a, b) => readText(a.source_ts).localeCompare(readText(b.source_ts)) || readText(a.id).localeCompare(readText(b.id)))
    .slice(-TAIL_LIMIT);
  const deltas = Object.values(state.deltas).filter(delta => delta.runId === row.run_id);
  return <details><summary>Conversation tail</summary>
    {messages.length === 0 && deltas.length === 0 && <p>No conversation content available.</p>}
    {messages.map(message => <div key={String(message.id)}><strong>{readText(message.role)}</strong>
      <pre style={{ whiteSpace: 'pre-wrap' }}>{message.body_state === 'stored' ? readBody(message.body) : `Content unavailable: ${readText(message.body_state)}`}</pre></div>)}
    {deltas.map((delta, index) => <pre key={index} style={{ whiteSpace: 'pre-wrap' }}>{delta.text}</pre>)}
  </details>;
}
export function ApprovalDetails({ row, state }: { row: Row; state: ScreenState }) {
  const run = state.projection.runs?.find(run => run.id === row.run_id);
  const request = readObject(row.request);
  const input = request.input && typeof request.input === 'object' ? request.input as Row : request;
  const command = input.command;
  const diff = input.diff ?? input.patch ?? request.changes ?? request.fileChanges;
  const status = executionStates.includes(run?.state as ExecutionState) ? run!.state as ExecutionState : 'unknown';
  const evidence = readObject(status === 'ended' ? run?.end_evidence : run?.last_evidence);
  return <><p>Run: <AppLink to={`/c/${encodeURIComponent(getConversation(row, state))}`}>{readText(row.run_id) || 'Unknown run'} · Evidence</AppLink></p>
    <StateBadge state={status} evidenceUrl={`/c/${encodeURIComponent(getConversation(row, state))}`}
      evidence={readText(evidence.kind ?? evidence.fact_id) || undefined}
      evidenceTime={run?.last_evidence_ts ? <time dateTime={readText(run.last_evidence_ts)}>{readText(run.last_evidence_ts)}</time> : undefined}
      reason={readText(run?.cause ?? run?.reason) || undefined}/>
    {command !== undefined && <pre aria-label="Full command" style={{ whiteSpace: 'pre-wrap' }}>{readText(command)}</pre>}
    {diff !== undefined && <pre aria-label="Expanded file diff" style={{ whiteSpace: 'pre-wrap' }}>{readText(diff)}</pre>}
    {(input.old_string !== undefined || input.new_string !== undefined) && <pre aria-label="Expanded file diff" style={{ whiteSpace: 'pre-wrap' }}>
      {`${readText(input.file_path)}\n${readText(input.old_string).split('\n').map(line => `-${line}`).join('\n')}\n${readText(input.new_string).split('\n').map(line => `+${line}`).join('\n')}`}</pre>}
    <pre aria-label="Full approval request" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{readText(row.request) || 'Request content unavailable.'}</pre>
    <ConversationTail row={row} state={state}/></>;
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
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS); return () => clearInterval(timer); }, []);
  async function answer(rows: Row[], action: ApprovalAction) {
    if (lock.current || !rows.length || rows.some(row => !getDecision(row, action))) return;
    lock.current = true; setBusy(true); setError('');
    const results = await Promise.allSettled(rows.map(row => answerApproval(client, row, action)));
    const successful = rows.filter((_, index) => results[index].status === 'fulfilled').map(row => String(row.id));
    setSent(previous => [...previous, ...successful]);
    setSelected(previous => previous.filter(id => !successful.includes(id)));
    setError(results.flatMap((result, index) => result.status === 'rejected' ? [`${rows[index].id}: ${String(result.reason)}`] : []).join('\n'));
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
  return <section aria-label="Approval inbox" onKeyDown={event => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || (event.target instanceof HTMLElement && (event.target.closest('input, textarea, select, [contenteditable="true"]')))) return;
    const action = (Object.keys(APPROVAL_KEYS) as ApprovalAction[]).find(action => APPROVAL_KEYS[action] === event.key.toLowerCase());
    if (!action) return;
    const focused = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-approval-id]')?.dataset.approvalId : undefined;
    const rows = active.length ? active : pending.filter(row => String(row.id) === focused && !sent.includes(String(row.id)));
    if (rows.length) { event.preventDefault(); void answer(rows, action); }
  }}>
    <h1>Approval inbox</h1><p role="status">Pending approvals: {pending.length}</p>
    <p>Select requests or focus a row. A: allow · D: deny · S: allow for this conversation.</p>
    <label><input type="checkbox" disabled={busy || pending.length === 0}
      checked={pending.some(row => !sent.includes(String(row.id))) && pending.filter(row => !sent.includes(String(row.id))).every(row => selected.includes(String(row.id)))}
      onChange={event => setSelected(event.target.checked ? pending.filter(row => !sent.includes(String(row.id))).map(row => String(row.id)) : [])}/>Select all pending</label>
    <div aria-label="Bulk answers">{(Object.keys(ACTION_LABELS) as ApprovalAction[]).map(action => <button key={action}
      disabled={busy || !active.length || active.some(row => !getDecision(row, action))}
      onClick={() => void answer(active, action)}>{ACTION_LABELS[action]} selected</button>)}</div>
    {error && <p role="alert">{error}</p>}
    <ol aria-label="Pending approvals">{pending.map(row => {
      const id = String(row.id);
      const timestamp = getRequestedTime(row, state);
      const elapsed = Date.parse(timestamp);
      return <li key={id} data-approval-id={id} tabIndex={0}>
        <label><input type="checkbox" aria-label={`Select ${id}`} disabled={busy || sent.includes(id)} checked={selected.includes(id)}
          onChange={event => setSelected(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))}/>{id}</label>
        <p>Waiting: {Number.isFinite(elapsed) ? `${Math.max(0, Math.floor((now - elapsed) / 1000))}s` : 'Start time unavailable'} {timestamp && <time dateTime={timestamp}>{timestamp}</time>}</p>
        <ApprovalDetails row={row} state={state}/>
        {(Object.keys(ACTION_LABELS) as ApprovalAction[]).map(action => <button key={action} disabled={busy || sent.includes(id) || !getDecision(row, action)}
          onClick={() => void answer([row], action)}>{ACTION_LABELS[action]}</button>)}
        {sent.includes(id) && <p>Answer sent; waiting for resolution.</p>}
      </li>;
    })}</ol>
    {pending.length === 0 && <p>No pending approvals.</p>}
    <h2>Expired</h2><ol aria-label="Expired approvals">{expired.map(row => <li key={String(row.id)}>
      <p>expired · {readText(row.id)} · {readText(row.reason)}</p><ApprovalDetails row={row} state={state}/>
      <button disabled={busy || !getConversation(row, state)} onClick={() => void resume(row)}>Resume run</button>
    </li>)}</ol>
  </section>;
}
export default Inbox;
