import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { Ack, createClient } from '../../lib/client.ts';
import { store, useScreenStore, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { dictionaries } from '../../lib/i18n.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { executionStates } from '../../components/activity.ts';
import { Message } from '../../components/conversation/Message.tsx';
import { ACTIVE_STATES, PENDING_APPROVALS, readObject, readText, selectTimeline, showValue } from '../../components/conversation/model.ts';
import { translate, type ConversationText } from '../../components/conversation/text.ts';
import './conversation.css';

export type ConversationClient = Pick<ReturnType<typeof createClient>, 'command'>;
interface Model { model: string; displayName: string; effort?: string }
export interface ConversationPageProps {
  client: ConversationClient;
  conversationId?: string;
  target?: ScreenStore;
  language?: Language;
  onConversation?: (conversationId: string) => void;
}
const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SUPPORTED_FORMATS = ['jsonl', 'legacy', 'paginated'];
const TICK_MS = 1000;

export function ConversationPage({ client, conversationId: explicitId, target = store, language = 'en', onConversation }: ConversationPageProps) {
  const params = useParams();
  const conversationId = explicitId ?? params.conversation ?? '';
  const visibleConversation = useRef(conversationId);
  visibleConversation.current = conversationId;
  const state = useScreenStore(target);
  const t = (key: ConversationText) => translate(language, key);
  const conversation = (state.projection.conversations ?? []).find(row => row.id === conversationId);
  const runs = (state.projection.runs ?? []).filter(row => row.conversation_id === conversationId);
  const run = [...runs].sort((a, b) => Number(b.generation) - Number(a.generation))[0];
  const provider = readText(conversation?.provider);
  const launch = readObject(run?.launch);
  const savedModel = readObject(launch.model ?? run?.model);
  const currentModel = readText(savedModel.model ?? run?.model);
  const currentEffort = readText(savedModel.effort ?? run?.effort);
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
  const canLaunch = connected && !pending && Boolean(model && cwd.trim()) && SUPPORTED_FORMATS.includes(readText(conversation?.history_format));
  const rawStatus = readText(run?.state);
  const status = executionStates.find(value => value === rawStatus) ?? 'unknown';
  const entries = selectTimeline(state, conversationId);

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

  if (!conversation) return <section className="conversation-page"><h1>{t('conversation')}</h1><p>{t('noConversation')}</p></section>;
  const evidence = run?.end_evidence ?? run?.last_evidence;
  const started = Date.parse(readText(status.startsWith('waiting') ? run?.last_evidence_ts : run?.started_ts));
  const elapsed = Number.isFinite(started) ? `${Math.max(0, Math.floor((now - started) / TICK_MS))}s` : t('unknown');
  return <section className="conversation-page" aria-label={t('conversation')}>
    <header className="conversation-heading"><p className="eyebrow">{provider}</p><h1>{readText(conversation.name) || t('conversation')}</h1>
      <StateBadge state={status} language={language} evidenceUrl="#conversation-evidence"
        evidence={showValue(status === 'ended' ? run?.end_evidence : run?.last_evidence) || undefined}
        evidenceTime={run?.last_evidence_ts ? <time dateTime={readText(run.last_evidence_ts)}>{readText(run.last_evidence_ts)}</time> : undefined}
        reason={readText(run?.cause ?? run?.reason) || undefined} elapsed={`${t(status.startsWith('waiting') ? 'waiting' : 'elapsed')}: ${elapsed}`}/>
      <dl className="conversation-metadata"><div><dt>{t('model')}</dt><dd>{appliedModel?.model || currentModel || t('unknown')}</dd></div>
        <div><dt>{t('effort')}</dt><dd>{appliedModel?.effort || currentEffort || t('unknown')}</dd></div>
        <div><dt>{t('worktree')}</dt><dd>{savedCwd || readText(run?.worktree_id) || t('unknown')}</dd></div>
        <div><dt>{t('coverage')}</dt><dd>{showValue(conversation.observation_coverage ?? conversation.coverage) || `${readText(conversation.history_format)} · ${t('noCoverage')}`}</dd></div></dl>
      <details id="conversation-evidence"><summary>{t('evidence')}</summary><pre>{showValue(evidence) || t('noRun')}</pre><time>{readText(run?.last_evidence_ts)}</time></details>
      {external && <p className="conversation-readonly">{t('readOnly')}</p>}
      {!SUPPORTED_FORMATS.includes(readText(conversation.history_format)) && <p>{t('unsupported')}</p>}
    </header>
    <div className="conversation-timeline" aria-label={t('conversation')}>
      {entries.length === 0 && <p className="muted">{t('empty')}</p>}
      {entries.map(entry => entry.kind === 'message' ? <Message key={entry.key} row={entry.row} language={language}/> : entry.kind === 'approval'
        ? <article className="conversation-approval" key={entry.key}><h2>{t('approval')}</h2><time>{entry.time || t('timeUnknown')}</time>
          <pre>{showValue(entry.row.request)}</pre><p>{readText(entry.row.state)} {readText(entry.row.reason)}</p>
          {Array.isArray(entry.row.available_decisions) && PENDING_APPROVALS.includes(readText(entry.row.state)) && entry.row.available_decisions.map(decision =>
            typeof decision === 'string' && <button key={decision} disabled={!writable || answered.has(entry.row.id)} onClick={() => void answer(entry.row.id, decision)}>{decision}</button>)}
        </article>
        : <div role="separator" className={`conversation-boundary ${entry.kind === 'gap' ? 'conversation-gap' : ''} ${entry.row.confidence === 'inferred' ? 'inferred' : ''}`} key={entry.key}>
          {entry.kind === 'gap' ? <>{t('missing')}: {showValue(entry.row.from_ts ?? entry.row.from)} – {showValue(entry.row.to_ts ?? entry.row.to)} {readText(entry.row.reason)}</>
            : <>{t(entry.row.type as ConversationText)} · {showValue(entry.row.from_id)} → {showValue(entry.row.to_id)} · {t('confidence')}: {readText(entry.row.confidence) || t('unknown')}</>}
          <time>{entry.time || t('timeUnknown')}</time>
        </div>)}
      {Object.entries(state.deltas).filter(([, delta]) => delta.conversationId === conversationId || !delta.conversationId && delta.runId === run?.id)
        .map(([key, delta]) => <Message key={key} language={language} streaming row={{ id: delta.messageId ?? key, role: 'assistant', body: delta.text, body_state: 'stored', source: `host-${provider}`, confidence: 'confirmed' }}/>) }
    </div>
    <footer className="conversation-composer">
      {state.connection !== 'connected' && <p role="status">{dictionaries[language][state.connection]}</p>}
      {error && <p role="alert">{error}</p>}{pending && <p role="status">{t('pending')}</p>}
      {nextConversation && <AppLink to={`/c/${encodeURIComponent(nextConversation)}`}>{t('conversation')}: {nextConversation}</AppLink>}
      {!codexActive && <div className="conversation-controls"><label>{t('model')}<select aria-label={t('model')} disabled={!connected || pending || confirmation !== undefined} value={model} onChange={event => {
        setModel(event.target.value);
        if (provider === 'codex') setEffort(models.find(item => item.model === event.target.value)?.effort ?? '');
      }}><option value="">{models.length ? t('chooseModel') : t('noModels')}</option>
        {model && !models.some(item => item.model === model) && <option value={model} disabled>{model}</option>}
        {models.map(item => <option key={item.model} value={item.model}>{item.displayName}</option>)}</select></label>
        <label>{t('effort')}<select aria-label={t('effort')} value={effort} disabled={!connected || pending || provider !== 'codex' || confirmation !== undefined} onChange={event => setEffort(event.target.value)}>
          <option value="">{t('unknown')}</option>{[...new Set([...CODEX_EFFORTS, ...(effort ? [effort] : [])])].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        {!external && <button disabled={!writable || !models.some(item => item.model === model)} onClick={() => void applyModel()}>{t('apply')}</button>}
      </div>}
      {modelsError && <p role="alert">{modelsError}</p>}
      <p className="muted">{t(provider === 'codex' ? codexActive ? 'activeCodex' : 'nextTurn' : 'claudeEffort')}</p>
      <label>{t('input')}<textarea value={input} readOnly={external} disabled={pending || !connected || !external && !canSend} onChange={event => setInput(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
      }}/></label>
      <div className="conversation-actions"><button disabled={!canSend || !input.trim()} onClick={() => void send()}>{t('send')}</button><span className="muted">{t('shortcut')}</span>
        <button disabled={!writable || !active} onClick={() => void execute('interrupt', { runId: run!.id })}>{t('interrupt')}</button></div>
      <label>{t('cwd')}<input value={cwd} disabled={pending || confirmation !== undefined} onChange={event => setCwd(event.target.value)}/></label>
      {(!model || !cwd.trim()) && <p className="muted">{t('launchReady')}</p>}
      <div className="conversation-actions">
        {!external && <button disabled={!canLaunch} onClick={() => void launchConversation('fork')}>{t('fork')}</button>}
        {external && <button disabled={!canLaunch || confirmation !== undefined} onClick={() => void launchConversation('adopt')}>{t('handoff')}</button>}
      </div>
      {confirmation && <section role="dialog" aria-modal="false" aria-label={t('stopped')} className="conversation-confirmation"><h2>{t('stopped')}</h2>
        <button disabled={pending} onClick={() => void launchConversation('adopt', true)}>{t('confirm')}</button>
        <button disabled={pending} onClick={() => void launchConversation('adopt', false)}>{t('branchInstead')}</button>
        <button disabled={pending} onClick={() => setConfirmation(undefined)}>{t('cancel')}</button>
      </section>}
    </footer>
  </section>;
}

export default ConversationPage;
