import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { Ack, createClient } from '../../lib/client.ts';
import { store, useScreenStore, type Row, type ScreenState, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { dictionaries } from '../../lib/i18n.ts';
import { conversationName, decisionLabel, evidenceLabel, formatClock, formatSeconds, isPositiveDecision, readApprovalRequest, readModel, runLabel, worktreeLabel } from '../../lib/format.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Fields } from '../../components/Fields.tsx';
import { ApprovalRequestView } from '../../components/ApprovalRequest.tsx';
import { providerName } from '../../components/ActivityRow.tsx';
import { executionStates } from '../../components/activity.ts';
import { Message } from '../../components/conversation/Message.tsx';
import { collectToolResults } from '../../components/conversation/ToolCall.tsx';
import { ACTIVE_STATES, PENDING_APPROVALS, readObject, readText, selectTimeline, showValue, type TimelineEntry } from '../../components/conversation/model.ts';
import { translate, type ConversationText } from '../../components/conversation/text.ts';
import './conversation.css';

export type ConversationClient = Pick<ReturnType<typeof createClient>, 'command'>;
interface Model { model: string; displayName: string; effort?: string }
export interface ConversationPageProps {
  client: ConversationClient;
  conversationId?: string;
  target?: ScreenStore;
  language?: Language;
  embedded?: boolean;
  onConversation?: (conversationId: string) => void;
}
const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SUPPORTED_FORMATS = ['jsonl', 'legacy', 'paginated'];
const TICK_MS = 1000;
const STICK_TO_BOTTOM_PX = 120;

function nameOf(state: ScreenState, id: unknown): string {
  const value = readText(id);
  return conversationName(state, value) || (state.projection.runs?.some(row => row.id === value) ? runLabel(state, value) : '') || 'another conversation';
}
function TimeStamp({ value, fallback }: { value: string; fallback: string }) {
  return value ? <time dateTime={value} title={value}>{formatClock(value) || value}</time> : <span className="muted-text">{fallback}</span>;
}
function ApprovalCard({ entry, t, disabled, answered, onAnswer }: {
  entry: TimelineEntry; t: (key: ConversationText) => string; disabled: boolean; answered: boolean; onAnswer: (decision: string) => void;
}) {
  const row = entry.row;
  const request = readApprovalRequest(row.request);
  const state = readText(row.state);
  const pending = PENDING_APPROVALS.includes(state);
  const decision = readText(row.decision);
  const outcome = decision ? (isPositiveDecision(decision) ? t('allowed') : t('denied')) : state === 'expired' ? t('expired') : state === 'stale' ? t('stale')
    : pending ? (answered ? t('answered') : t('pendingState')) : t('resolved');
  const decisions = Array.isArray(row.available_decisions) ? row.available_decisions.filter((value): value is string => typeof value === 'string') : [];
  return <article className={`timeline-approval ${pending ? 'is-pending' : 'is-settled'}`} aria-label={t('approval')}>
    <header><Icon name={pending ? 'alert' : 'check'} size={14}/><strong>{t('approval')}</strong><span className="tool-name">{request.tool}</span>
      {request.summary && <span className="truncate muted-text">{request.summary}</span>}
      <span className="spacer"/><span className={`chip ${pending ? 'chip-attention' : 'chip-quiet'}`}>{outcome}</span>
      <TimeStamp value={entry.time} fallback={t('timeUnknown')}/></header>
    <ApprovalRequestView request={row.request} compact/>
    {readText(row.reason) && <p className="muted-text">{readText(row.reason)}</p>}
    {pending && decisions.length > 0 && <div className="button-row">{decisions.map(value => <button key={value}
      className={`btn btn-sm btn-secondary${isPositiveDecision(value) ? ' btn-allow' : ''}`}
      disabled={disabled || answered} onClick={() => onAnswer(value)}>
      <Icon name={isPositiveDecision(value) ? 'check' : 'x'} size={14}/>{decisionLabel(value)}</button>)}</div>}
  </article>;
}

export function ConversationPage({ client, conversationId: explicitId, target = store, language = 'en', embedded = false, onConversation }: ConversationPageProps) {
  const params = useParams();
  const conversationId = explicitId ?? params.conversation ?? '';
  const visibleConversation = useRef(conversationId);
  visibleConversation.current = conversationId;
  const timeline = useRef<HTMLDivElement>(null);
  const state = useScreenStore(target);
  const t = (key: ConversationText) => translate(language, key);
  const conversation = (state.projection.conversations ?? []).find(row => row.id === conversationId);
  const runs = (state.projection.runs ?? []).filter(row => row.conversation_id === conversationId);
  const run = [...runs].sort((a, b) => Number(b.generation) - Number(a.generation))[0];
  const provider = readText(conversation?.provider);
  const launch = readObject(run?.launch);
  const saved = readModel(run);
  const currentModel = saved.model || readText(run?.model);
  const currentEffort = saved.effort || readText(run?.effort);
  const savedCwd = readText(launch.cwd ?? run?.cwd ?? run?.worktree_path);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsError, setModelsError] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [cwd, setCwd] = useState('');
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{ cwd: string; model: { model: string; effort?: string }; input: { text: string }; conversationId: string }>();
  const [nextConversation, setNextConversation] = useState('');
  const [answered, setAnswered] = useState<Set<unknown>>(new Set());
  const [appliedModel, setAppliedModel] = useState<{ model: string; effort: string }>();
  const [now, setNow] = useState(Date.now());
  const external = conversation?.origin !== 'managed';
  const active = ACTIVE_STATES.includes(readText(run?.state));
  const codexActive = provider === 'codex' && active && !external;
  const connected = state.connection === 'connected';
  const open = Boolean(run && [...ACTIVE_STATES, 'idle'].includes(readText(run.state)));
  const writable = !external && open && connected && !pending;
  const canSend = writable && !codexActive;
  const supported = SUPPORTED_FORMATS.includes(readText(conversation?.history_format));
  const canLaunch = connected && !pending && Boolean(model && cwd.trim()) && supported;
  const rawStatus = readText(run?.state);
  const status = executionStates.find(value => value === rawStatus) ?? 'unknown';
  const entries = selectTimeline(state, conversationId);
  const toolResults = collectToolResults(entries.filter(entry => entry.kind === 'message').map(entry => entry.row));
  const deltas = Object.entries(state.deltas).filter(([, delta]) => delta.conversationId === conversationId || !delta.conversationId && delta.runId === run?.id);
  const streamLength = deltas.reduce((total, [, delta]) => total + delta.text.length, 0);

  useEffect(() => {
    setModel(currentModel); setEffort(currentEffort); setCwd(savedCwd);
  }, [conversationId, currentModel, currentEffort, savedCwd]);
  useEffect(() => {
    setInput(''); setError(''); setConfirmation(undefined); setNextConversation('');
    setPending(false); setAnswered(new Set()); setAppliedModel(undefined);
  }, [conversationId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // 末尾を見ている間だけ、新しい発言と幅の変化に合わせて下へ送る。利用者が上へ送ったら追わない。
  const following = useRef(true);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = timeline.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [entries.length, streamLength, conversationId]);
  useEffect(() => {
    const element = timeline.current;
    if (!element || !inner.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (following.current) element.scrollTop = element.scrollHeight; });
    observer.observe(inner.current); observer.observe(element);
    return () => observer.disconnect();
  }, [conversation !== undefined]);
  function nearBottom(element: HTMLElement) { return element.scrollHeight - element.scrollTop - element.clientHeight < STICK_TO_BOTTOM_PX; }
  function userScrolled() {
    requestAnimationFrame(() => { if (timeline.current) following.current = nearBottom(timeline.current); });
  }
  useEffect(() => {
    let disposed = false;
    setModels([]); setModelsError('');
    if (!provider || !connected) return;
    void client.command('list_models', { provider }).then(ack => {
      if (disposed) return;
      if (!ack.ok) { setModelsError(ack.error ?? t('failed')); return; }
      setModels((Array.isArray(ack.result) ? ack.result : []).flatMap(item => {
        const value = readObject(item);
        return typeof value.model === 'string' ? [{ model: value.model, displayName: readText(value.displayName) || value.model, effort: readText(value.effort) || undefined }] : [];
      }));
    }).catch(reason => { if (!disposed) setModelsError(String(reason)); });
    return () => { disposed = true; };
  }, [client, provider, connected, language, conversationId]);

  async function execute(command: string, payload: unknown): Promise<Ack | undefined> {
    if (pending || !connected) return;
    const sourceConversation = conversationId;
    setPending(true); setError('');
    try {
      const ack = await client.command(command, payload);
      if (visibleConversation.current !== sourceConversation) return;
      if (!ack.ok) { setError(ack.error ?? t('failed')); return; }
      return ack;
    } catch (reason) { if (visibleConversation.current === sourceConversation) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (visibleConversation.current === sourceConversation) setPending(false); }
  }
  async function send() {
    if (!canSend || !input.trim()) return;
    const sent = input;
    following.current = true;
    if (await execute('send', { runId: run!.id, input: { text: sent } })) setInput(value => value === sent ? '' : value);
  }
  function follow(ack: Ack) {
    const id = readText(readObject(ack.result).conversationId);
    if (id && id !== conversationId) { setNextConversation(id); onConversation?.(id); }
  }
  async function applyModel() {
    if (await execute('set_model', { runId: run!.id, model: { model, ...(effort ? { effort } : {}) } })) setAppliedModel({ model, effort });
  }
  async function answer(approvalId: unknown, decision: string) {
    if (await execute('answer', { approvalId, decision })) setAnswered(previous => new Set([...previous, approvalId]));
  }
  async function launchConversation(command: 'fork' | 'adopt', confirmStopped?: boolean) {
    if (!canLaunch) return;
    const payload = confirmStopped === undefined ? { conversationId, cwd: cwd.trim(), model: { model, ...(effort ? { effort } : {}) }, input: { text: input } }
      : { ...confirmation!, confirmStopped };
    const ack = await execute(command, payload);
    if (!ack) return;
    if (readObject(ack.result).confirmation_required === true) setConfirmation(payload);
    else { setConfirmation(undefined); follow(ack); }
  }

  if (!conversation) return <section className={`conversation-page missing${embedded ? ' embedded' : ''}`}><div className="empty-state">
    <Icon name="message" size={22}/><h1>{t('conversation')}</h1><p>{t('noConversation')}</p></div></section>;
  const Heading = embedded ? 'h2' : 'h1';
  const evidence = status === 'ended' ? run?.end_evidence : run?.last_evidence;
  const started = Date.parse(readText(status.startsWith('waiting') ? run?.last_evidence_ts : run?.started_ts));
  const elapsed = Number.isFinite(started) ? formatSeconds(Math.max(0, Math.floor((now - started) / TICK_MS))) : '';
  const worktree = worktreeLabel(run);
  const shownModel = appliedModel?.model || currentModel;
  const shownEffort = appliedModel?.effort || currentEffort;
  const title = readText(conversation.name) || conversationName(state, conversationId) || t('conversation');
  const dirty = Boolean(model) && (model !== currentModel || effort !== currentEffort);
  const hint = provider === 'codex' ? codexActive ? 'activeCodex' : 'nextTurn' : 'claudeEffort';
  return <section className={`conversation-page${embedded ? ' embedded' : ''}`} aria-label={t('conversation')}>
    <header className="conv-header">
      <div className="conv-title-row"><Heading className="conv-title truncate" title={title}>{title}</Heading>
        <StateBadge state={status} language={language} evidenceUrl="#conversation-evidence"
          evidence={evidenceLabel(evidence) || undefined}
          evidenceTime={run?.last_evidence_ts ? <time dateTime={readText(run.last_evidence_ts)} title={readText(run.last_evidence_ts)}>{formatClock(run.last_evidence_ts) || readText(run.last_evidence_ts)}</time> : undefined}
          reason={readText(run?.cause ?? run?.reason) || undefined} elapsed={elapsed ? `${t(status.startsWith('waiting') ? 'waiting' : 'elapsed')} ${elapsed}` : undefined}/>
      </div>
      <dl className="conv-meta">
        {provider && <div><dt className="sr-only">Provider</dt><dd><span className={`provider-mark provider-${provider}`}>{providerName(provider)}</span></dd></div>}
        <div title={t('model')}><dt className="sr-only">{t('model')}</dt><dd className="meta-item"><Icon name="cpu" size={14}/>
          {shownModel ? <span className="mono">{shownModel}</span> : <span className="muted-text">{t('noModel')}</span>}</dd></div>
        <div title={t('effort')}><dt className="sr-only">{t('effort')}</dt><dd className="meta-item">{shownEffort ? <span className="chip chip-quiet">{t('effort')} · {shownEffort}</span>
          : <span className="chip chip-quiet">{t('defaultEffort')}</span>}</dd></div>
        <div title={worktree?.full || t('worktree')}><dt className="sr-only">{t('worktree')}</dt><dd className="meta-item"><Icon name="branch" size={14}/>
          {worktree ? <><span className="truncate mono">{worktree.place}</span>{worktree.branch && <span className="branch-name mono">{worktree.branch}</span>}</>
            : <span className="muted-text">{t('noWorktree')}</span>}</dd></div>
        <div title={t('coverage')}><dt className="sr-only">{t('coverage')}</dt><dd className="meta-item"><Icon name="link" size={14}/>
          <span>{readText(conversation.observation_coverage ?? conversation.coverage)
            || (external ? `${t('observedCoverage')} · ${readText(conversation.history_format) || t('unknown')}` : t('managedCoverage'))}</span></dd></div>
      </dl>
      <details className="evidence-panel" id="conversation-evidence"><summary><Icon name="chevronRight" size={12} className="caret"/>{t('evidence')}</summary>
        <div className="evidence-body">{evidence !== undefined && evidence !== null ? <Fields value={readObject(evidence)} empty={evidenceLabel(evidence) || t('noRun')}/> : <span className="muted-text">{t('noRun')}</span>}
          {readText(run?.last_evidence_ts) && <TimeStamp value={readText(run?.last_evidence_ts)} fallback=""/>}</div></details>
      {external && <p className="banner banner-readonly"><Icon name="lock" size={14}/>{t('readOnly')}</p>}
      {!supported && <p className="banner banner-warning"><Icon name="alert" size={14}/>{t('unsupported')}</p>}
    </header>
    <div className="conv-timeline" ref={timeline} aria-label={t('conversation')} tabIndex={0}
      onScroll={event => { if (nearBottom(event.currentTarget)) following.current = true; }}
      onWheel={userScrolled} onTouchMove={userScrolled} onKeyDown={userScrolled} onPointerUp={userScrolled}><div className="conv-timeline-inner" ref={inner}>
      {entries.length === 0 && deltas.length === 0 && <p className="timeline-empty"><Icon name="message" size={16}/>{t('empty')}</p>}
      {entries.map(entry => entry.kind === 'message' ? <Message key={entry.key} row={entry.row} language={language} agent={providerName(provider)} toolResults={toolResults}/>
        : entry.kind === 'approval' ? <ApprovalCard key={entry.key} entry={entry} t={t} disabled={!writable} answered={answered.has(entry.row.id)} onAnswer={decision => void answer(entry.row.id, decision)}/>
        : <div role="separator" className={`timeline-boundary${entry.kind === 'gap' ? ' gap' : ''}${entry.row.confidence === 'inferred' ? ' inferred' : ''}`} key={entry.key}>
          {entry.kind === 'gap' ? <>{t('missing')}: {showValue(entry.row.from_ts ?? entry.row.from)} – {showValue(entry.row.to_ts ?? entry.row.to)} {readText(entry.row.reason)}</>
            : <>{t(entry.row.type as ConversationText)} · {nameOf(state, entry.row.from_id)} → {nameOf(state, entry.row.to_id)} · {t('confidence')}: {readText(entry.row.confidence) || t('unknown')}</>}
          <TimeStamp value={entry.time} fallback={t('timeUnknown')}/>
        </div>)}
      {deltas.map(([key, delta]) => <Message key={key} language={language} streaming agent={providerName(provider)}
        row={{ id: delta.messageId ?? key, role: 'assistant', body: delta.text, body_state: 'stored' } satisfies Row}/>)}
    </div></div>
    <footer className="composer">
      {(state.connection !== 'connected' || error || pending || nextConversation || modelsError) && <div className="composer-status">
        {state.connection !== 'connected' && <p role="status" className="status-line"><Icon name="unknown" size={14}/>{dictionaries[language][state.connection]}</p>}
        {error && <p role="alert" className="status-line danger"><Icon name="alert" size={14}/>{error}</p>}
        {pending && <p role="status" className="status-line">{t('pending')}</p>}
        {modelsError && <p role="alert" className="status-line danger">{modelsError}</p>}
        {nextConversation && <AppLink className="status-line" to={`/c/${encodeURIComponent(nextConversation)}`}>{t('conversation')}: {nameOf(state, nextConversation) === 'another conversation' ? nextConversation : nameOf(state, nextConversation)}</AppLink>}
      </div>}
      {confirmation && <section role="dialog" aria-modal="false" aria-label={t('stopped')} className="confirm-panel"><h3>{t('stopped')}</h3>
        <div className="button-row"><button className="btn btn-primary btn-sm" disabled={pending} onClick={() => void launchConversation('adopt', true)}>{t('confirm')}</button>
          <button className="btn btn-secondary btn-sm" disabled={pending} onClick={() => void launchConversation('adopt', false)}>{t('branchInstead')}</button>
          <button className="btn btn-ghost btn-sm" disabled={pending} onClick={() => setConfirmation(undefined)}>{t('cancel')}</button></div>
      </section>}
      <div className={`composer-box${external ? ' readonly' : ''}`}>
        <textarea aria-label={t('input')} rows={2} placeholder={external ? t('readOnlyPlaceholder') : t('placeholder')} value={input} readOnly={external}
          disabled={pending || !connected || !external && !canSend} onChange={event => setInput(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }}/>
        <div className="composer-toolbar">
          <div className="composer-controls">
            {!codexActive && <>
              <select className="select-sm" aria-label={t('model')} title={t('model')} disabled={!connected || pending || confirmation !== undefined} value={model} onChange={event => {
                setModel(event.target.value);
                if (provider === 'codex') setEffort(models.find(item => item.model === event.target.value)?.effort ?? '');
              }}><option value="">{models.length ? t('chooseModel') : t('noModels')}</option>
                {model && !models.some(item => item.model === model) && <option value={model} disabled>{model}</option>}
                {models.map(item => <option key={item.model} value={item.model}>{item.displayName}</option>)}</select>
              <select className="select-sm" aria-label={t('effort')} title={provider === 'codex' ? t('effort') : t('claudeEffort')} value={effort}
                disabled={!connected || pending || provider !== 'codex' || confirmation !== undefined} onChange={event => setEffort(event.target.value)}>
                <option value="">{t('defaultEffort')}</option>{[...new Set([...CODEX_EFFORTS, ...(effort ? [effort] : [])])].map(value => <option key={value} value={value}>{value}</option>)}
              </select>
              {!external && <button className="btn btn-ghost btn-sm" aria-label={t('apply')} title={t('apply')} disabled={!writable || !models.some(item => item.model === model) || !dirty}
                onClick={() => void applyModel()}>{t('applyShort')}</button>}
            </>}
            {!savedCwd && <input className="input-sm" aria-label={t('cwd')} placeholder={t('cwd')} value={cwd} disabled={pending || confirmation !== undefined} onChange={event => setCwd(event.target.value)}/>}
          </div>
          <div className="composer-actions">
            {!external && <button className="btn btn-ghost btn-sm" aria-label={t('fork')} title={canLaunch ? t('fork') : t('launchReady')} disabled={!canLaunch} onClick={() => void launchConversation('fork')}>
              <Icon name="fork" size={14}/>{t('branchShort')}</button>}
            <button className="btn btn-secondary btn-sm" disabled={!writable || !active} onClick={() => void execute('interrupt', { runId: run!.id })}><Icon name="stop" size={13}/>{t('interrupt')}</button>
            {external ? <>
              <button className="btn btn-secondary btn-sm" disabled>{t('send')}</button>
              <button className="btn btn-primary btn-sm" aria-label={t('handoff')} title={canLaunch ? t('handoff') : t('launchReady')} disabled={!canLaunch || confirmation !== undefined} onClick={() => void launchConversation('adopt')}>
                <Icon name="play" size={13}/>{t('takeOverShort')}</button></>
              : <button className="btn btn-primary btn-sm" title={t('shortcut')} disabled={!canSend || !input.trim()} onClick={() => void send()}><Icon name="send" size={14}/>{t('send')}</button>}
          </div>
        </div>
      </div>
      <p className="composer-hint"><span>{t(hint)}</span>{!external && <> · <kbd>⌘</kbd><kbd>Enter</kbd></>}{(!model || !cwd.trim()) && <> · <span>{t('launchReady')}</span></>}</p>
    </footer>
  </section>;
}

export default ConversationPage;
