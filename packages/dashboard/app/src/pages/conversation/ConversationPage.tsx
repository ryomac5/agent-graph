import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { getRegisteredProjects, OTHER_PROJECT } from '../../lib/projects.ts';
import { compareMessages, loadConversationWindow, MESSAGE_PAGE_SIZE } from '../../lib/projection-client.ts';
import { staleApprovalText } from '../changes/model.ts';
import type { Ack, createClient } from '../../lib/client.ts';
import { store, useScreenStore, type Row, type ScreenState, type ScreenStore } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import { dictionaries } from '../../lib/i18n.ts';
import { approvalOutcome, approvalReasonText, type ApprovalOutcome, conversationName, decisionLabel, evidenceLabel, formatClock, formatSeconds, agentName, modelName, isPositiveDecision, readApprovalRequest, readModel, runLabel, worktreeLabel } from '../../lib/format.ts';
import { AppLink } from '../../components/AppLink.tsx';
import { StateBadge } from '../../components/StateBadge.tsx';
import { reasonText } from '../../lib/reasons.ts';
import { RelativeTime } from '../../components/RelativeTime.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Fields } from '../../components/Fields.tsx';
import { ApprovalRequestView, OutcomeChip, OutcomeIcon } from '../../components/ApprovalRequest.tsx';
import { providerName } from '../../components/ActivityRow.tsx';
import { executionStates } from '../../components/activity.ts';
import { countTools, isBlank, isToolOnly, Message } from '../../components/conversation/Message.tsx';
import { harnessKind, readBody } from '../../lib/message-body.ts';
import { collectToolResults } from '../../components/conversation/ToolCall.tsx';
import { resolveParticipants, senderOf, type Sender } from '../../components/conversation/participants.ts';
import { ACTIVE_STATES, compareEntries, PENDING_APPROVALS, readObject, readText, selectTimeline, showValue, type TimelineEntry } from '../../components/conversation/model.ts';
import { translate, type ConversationText } from '../../components/conversation/text.ts';
import './conversation.css';

export type ConversationClient = Pick<ReturnType<typeof createClient>, 'command'> & Partial<Pick<ReturnType<typeof createClient>, 'watchConversation' | 'fetchConversation'>>;
interface Model { model: string; displayName: string; effort?: string }
export interface ConversationPageProps {
  client: ConversationClient;
  conversationId?: string;
  target?: ScreenStore;
  language?: Language;
  embedded?: boolean;
  seriesIds?: string[];
  /** 系列の状態。一覧と同じ、系列の最新の会話の実行の状態を見出しに出す。 */
  seriesState?: string;
  displayName?: string;
  onConversation?: (conversationId: string) => void;
}
const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SUPPORTED_FORMATS = ['jsonl', 'legacy', 'paginated'];
const TICK_MS = 1000;
const STICK_TO_BOTTOM_PX = 120;

type ToolRunEntry = { kind: 'tools'; key: string; rows: TimelineEntry[] };
/** 続く道具だけの発言を 1 つにまとめる。本文のある発言と区切りと承認は、そのまま残す。 */
function groupToolRuns(entries: TimelineEntry[]): (TimelineEntry | ToolRunEntry)[] {
  const grouped: (TimelineEntry | ToolRunEntry)[] = [];
  for (const entry of entries) {
    // 何も出さない行は、畳みの続きとして扱い、まとまりを切らない。
    if (entry.kind === 'message' && isBlank(entry.row)) {
      const last = grouped.at(-1);
      if (last?.kind === 'tools') last.rows.push(entry);
      continue;
    }
    if (entry.kind === 'message' && readText(entry.row.role) !== 'user' && isToolOnly(entry.row)) {
      const last = grouped.at(-1);
      if (last?.kind === 'tools') last.rows.push(entry);
      else grouped.push({ kind: 'tools', key: 'tools:' + entry.key, rows: [entry] });
      continue;
    }
    // 道具の結果だけの利用者の行は、直前の畳みに入れる。
    if (entry.kind === 'message' && readText(entry.row.role) === 'user' && isToolOnly(entry.row) && grouped.at(-1)?.kind === 'tools') {
      (grouped.at(-1) as ToolRunEntry).rows.push(entry);
      continue;
    }
    grouped.push(entry);
  }
  return grouped;
}
function nameOf(state: ScreenState, id: unknown): string {
  const value = readText(id);
  return conversationName(state, value) || (state.projection.runs?.some(row => row.id === value) ? runLabel(state, value) : '') || 'another conversation';
}
function TimeStamp({ value, fallback }: { value: string; fallback: string }) {
  return value ? <time dateTime={value} title={value}>{formatClock(value) || value}</time> : <span className="muted-text">{fallback}</span>;
}
function ApprovalCard({ entry, t, disabled, answered, onAnswer, screen }: {
  screen: ScreenState; entry: TimelineEntry; t: (key: ConversationText) => string; disabled: boolean; answered: boolean; onAnswer: (decision: string) => void;
}) {
  const row = entry.row;
  const request = readApprovalRequest(row.request);
  const artifact = screen.projection.artifacts?.find(artifact => artifact.id === row.artifact_id);
  const run = screen.projection.runs?.find(run => run.id === (artifact?.run_id ?? row.run_id));
  const conversation = screen.projection.conversations?.find(conversation => conversation.id === (run?.conversation_id ?? row.conversation_id));
  const task = screen.projection.tasks?.find(task => task.id === conversation?.task_id);
  const projectId = readText(conversation?.project ?? task?.project ?? artifact?.repository_id);
  const project = getRegisteredProjects(screen).some(row => row.id === projectId) ? projectId : OTHER_PROJECT;
  const changesQuery = row.artifact_id ? `artifact=${encodeURIComponent(readText(row.artifact_id))}` : `run=${encodeURIComponent(readText(row.run_id))}`;
  const review = row.state === 'stale' || Boolean(row.artifact_id && !row.request);
  const state = readText(row.state);
  const pending = PENDING_APPROVALS.includes(state);
  const outcome = approvalOutcome(row, answered);
  const labels: Record<ApprovalOutcome, ConversationText> = { pending: 'pendingState', answered: 'answered', allowed: 'allowed', denied: 'denied', expired: 'expired', stale: 'stale', resolved: 'resolved' };
  const decisions = Array.isArray(row.available_decisions) ? row.available_decisions.filter((value): value is string => typeof value === 'string') : [];
  // 回答を待つ要求は開いて出す。済んだ要求は 1 行に畳む。
  const [open, setOpen] = useState(pending);
  useEffect(() => setOpen(pending), [pending]);
  return <article className={`timeline-approval ${pending ? 'is-pending' : 'is-settled'} outcome-${outcome}`} aria-label={t('approval')} data-outcome={outcome}>
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary><Icon name="chevronRight" size={14} className="caret"/><OutcomeIcon outcome={outcome}/><strong>{t('approval')}</strong>{!review && <span className="tool-name">{request.tool}</span>}
        {!review && request.summary && <span className="truncate muted-text">{request.summary}</span>}
        <span className="spacer"/><OutcomeChip row={row} answered={answered} label={value => t(labels[value])}/>
        <TimeStamp value={entry.time} fallback={t('timeUnknown')}/></summary>
      <div className="approval-body">
        {review ? <><p>{row.state === 'stale' ? staleApprovalText(artifact) : 'Approval requested for this change.'}</p><AppLink to={`/p/${encodeURIComponent(project)}/changes?${changesQuery}`}>View changes</AppLink></> : <><ApprovalRequestView request={row.request} compact/>{approvalReasonText(readText(row.reason)) && <p className="muted-text">{approvalReasonText(readText(row.reason))}</p>}</>}
        {pending && decisions.length > 0 && <div className="button-row">{decisions.map(value => <button key={value}
          className={`btn btn-sm btn-secondary${isPositiveDecision(value) ? ' btn-allow' : ''}`}
          disabled={disabled || answered} onClick={() => onAnswer(value)}>
          <Icon name={isPositiveDecision(value) ? 'check' : 'x'} size={14}/>{decisionLabel(value)}</button>)}</div>}
      </div>
    </details>
  </article>;
}

export function ConversationPage({ client, conversationId: explicitId, target = store, language = 'en', embedded = false, seriesIds, seriesState, displayName, onConversation }: ConversationPageProps) {
  const params = useParams();
  const conversationId = explicitId ?? params.conversation ?? '';
  const visibleConversation = useRef(conversationId);
  visibleConversation.current = conversationId;
  const timeline = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const state = useScreenStore(target);
  const location = useLocation();
  const anchorId = location.hash.startsWith('#message-') ? decodeURIComponent(location.hash.slice(9)) : undefined;
  const [detail, setDetail] = useState<{ id: string; projection: Record<string, Row[]>; hasOlder: boolean }>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);
  const historyController = useRef<AbortController | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  // 入力欄を使おうとするまでは、入力の準備に関わる注意を出さない。
  const [engaged, setEngaged] = useState(false);
  // 端末の会話は見るだけで始め、利用者が続けると決めたときだけ入力欄を出す。
  const [continueHere, setContinueHere] = useState(false);
  const [handoffBlocked, setHandoffBlocked] = useState(false);
  const external = conversation?.origin !== 'managed';
  const active = ACTIVE_STATES.includes(readText(run?.state));
  const codexActive = provider === 'codex' && active && !external;
  const connected = state.connection === 'connected';
  const open = Boolean(run && [...ACTIVE_STATES, 'idle'].includes(readText(run.state)));
  const writable = !external && open && connected && !pending;
  const canSend = writable && !codexActive;
  const supported = SUPPORTED_FORMATS.includes(readText(conversation?.history_format));
  // 未対応の形式でも押せるようにし、押したときに理由を出す。
  const canLaunch = connected && !pending && Boolean(model && cwd.trim());
  const rawStatus = seriesState ?? readText(run?.state);
  const status = executionStates.find(value => value === rawStatus) ?? 'unknown';
  const local = detail?.id === conversationId ? detail.projection : {};
  const combine = (table: string) => [...new Map([...(local[table] ?? []), ...(state.projection[table] ?? [])].map(row => [readText(row.id), row])).values()];
  const historyState = { ...state, projection: { ...state.projection, messages: combine('messages'), message_memberships: combine('message_memberships') } };
  const historyIds = seriesIds?.length ? seriesIds : [conversationId];
  const seriesKey = historyIds.join('|');
  const seenMessages = new Set<unknown>();
  // 系列の発言は会話をまたいで時刻順に並べる。最新の発言が末尾に来る。会話が替わる所に区切りを 1 つ置く。
  const owner = new Map<string, string>();
  const seriesEntries = historyIds.flatMap(id => selectTimeline(historyState, id).filter(entry => {
    if (entry.kind === 'boundary' && seriesIds && ['continued', 'compacted'].includes(readText(entry.row.type))) return false;
    if (entry.kind !== 'message') return true;
    if (seenMessages.has(entry.row.id)) return false;
    seenMessages.add(entry.row.id); owner.set(entry.key, id); return true;
  }));
  if (historyIds.length > 1) seriesEntries.sort(compareEntries);
  const seriesStarted = new Set<string>();
  const allEntries = seriesEntries.flatMap(entry => {
    const id = owner.get(entry.key);
    if (!id || seriesStarted.has(id)) return [entry];
    const first = seriesStarted.size === 0;
    seriesStarted.add(id);
    return first ? [entry] : [{ kind: 'boundary', key: 'series:' + id, time: entry.time, row: { type: 'continued', series: true } } satisfies TimelineEntry, entry];
  });
  const messageEntries = allEntries.filter(entry => entry.kind === 'message');
  // 動いている間は、最後の人の発言からの経過と、最後に使った道具を末尾に出す。端末の「Cogitating…」に当たる。
  const lastHuman = [...messageEntries].reverse().find(entry => readText(entry.row.role) === 'user' && !isToolOnly(entry.row) && !isBlank(entry.row)
    && harnessKind(readBody(entry.row.body)) === 'user');
  const lastTool = [...messageEntries].reverse().flatMap(entry => Array.isArray(entry.row.body) ? entry.row.body.map(readObject).filter(block => block.type === 'tool_use').map(block => readText(block.name)).reverse() : [])[0];
  const shownMessages = new Set(messageEntries.slice(-messageLimit).map(entry => entry.row.id));
  if (anchorId) shownMessages.add(anchorId);
  const entries = allEntries.filter(entry => entry.kind !== 'message' || shownMessages.has(entry.row.id));
  async function loadHistory(older = false) {
    historyController.current?.abort();
    const controller = new AbortController(); historyController.current = controller;
    setHistoryLoading(true); setHistoryError('');
    const previous = older && detailRef.current?.id === conversationId ? detailRef.current : undefined;
    try {
      // 系列は最新の会話から読む。読めた会話から順に出し、古い会話は後から上に足す。
      const order = [...historyIds].reverse();
      const pages: Awaited<ReturnType<typeof loadConversationWindow>>[] = [];
      for (const id of order) {
        const part = await loadConversationWindow(id, controller.signal,
          older ? previous?.projection.messages?.filter(row => previous.projection.message_memberships?.some(link => link.message_id === row.id && link.conversation_id === id)).toSorted(compareMessages)[0] : undefined,
          older ? undefined : anchorId, client.fetchConversation ? path => client.fetchConversation!(path, controller.signal) : undefined);
        if (controller.signal.aborted || visibleConversation.current !== conversationId) return;
        if (pages.length && part.generation !== pages[0].generation) throw new Error('Conversation changed. Please retry.');
        pages.push(part);
        const page = { generation: pages[0].generation, hasOlder: pages.some(page => page.hasOlder) || pages.length < order.length, projection: {} as Record<string, Row[]> };
        for (const piece of pages) for (const [table, rows] of Object.entries(piece.projection)) page.projection[table] = [...(page.projection[table] ?? []), ...rows];
        if (page.generation !== target.getSnapshot().generation) throw new Error('Conversation changed. Please retry.');
        const projection = Object.fromEntries(Object.entries(page.projection).map(([table, rows]) => [table,
          [...new Map([...(previous?.projection[table] ?? []), ...rows].map(row => [readText(row.id), row])).values()]]));
        setDetail({ id: conversationId, projection, hasOlder: pages.length === order.length ? pages.some(page => page.hasOlder) : page.hasOlder });
        // 一覧の先頭のページにない会話も、api が返す投影の行で名前を出す。
        if (part.conversation && part.generation !== undefined) target.mergeProjection({ conversations: [part.conversation] }, part.generation);
      }
      if (older) { following.current = false; setMessageLimit(value => value + MESSAGE_PAGE_SIZE); }
    } catch (error) { if (!controller.signal.aborted) setHistoryError(`Unable to load messages. ${error instanceof Error ? error.message : ''}`.trim()); }
    finally { if (!controller.signal.aborted) setHistoryLoading(false); }
  }
  useEffect(() => {
    setDetail(undefined); setMessageLimit(MESSAGE_PAGE_SIZE); following.current = !anchorId;
    const releases = historyIds.map(id => client.watchConversation?.(id));
    void loadHistory();
    return () => { historyController.current?.abort(); for (const release of releases) release?.(); };
  }, [conversationId, seriesKey, state.generation, client, anchorId, historyRevision]);
  useEffect(() => {
    if (!anchorId || !shownMessages.has(anchorId)) return;
    const element = document.getElementById(`message-${encodeURIComponent(anchorId)}`);
    if (element) { following.current = false; element.scrollIntoView?.({ block: 'center' }); }
  }, [detail, anchorId]);
  const toolResults = collectToolResults(entries.filter(entry => entry.kind === 'message').map(entry => entry.row));
  const deltas = Object.entries(state.deltas).filter(([, delta]) => historyIds.includes(delta.conversationId ?? '') || !delta.conversationId && delta.runId === run?.id);
  const streamLength = deltas.reduce((total, [, delta]) => total + delta.text.length, 0);

  useEffect(() => {
    setModel(currentModel); setEffort(currentEffort); setCwd(savedCwd);
  }, [conversationId, currentModel, currentEffort, savedCwd]);
  useEffect(() => {
    setInput(''); setError(''); setConfirmation(undefined); setNextConversation('');
    setPending(false); setAnswered(new Set()); setAppliedModel(undefined);
    setDetailsOpen(false); setEngaged(false); setHandoffBlocked(false);
  }, [conversationId]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  // 末尾を見ている間だけ、新しい発言と幅の変化に合わせて下へ送る。利用者が上へ送ったら追わない。
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
    if (!supported) { setHandoffBlocked(true); return; }
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
  const elapsed = !seriesIds && ['running', 'starting'].includes(status) && Number.isFinite(started) ? formatSeconds(Math.max(0, Math.floor((now - started) / TICK_MS))) : '';
  const worktree = worktreeLabel(run);
  const shownModel = appliedModel?.model || currentModel;
  const shownEffort = appliedModel?.effort || currentEffort;
  const title = displayName || conversationName(state, conversationId) || t('conversation');
  const dirty = Boolean(model) && (model !== currentModel || effort !== currentEffort);
  const hint = provider === 'codex' ? codexActive ? 'activeCodex' : 'nextTurn' : 'claudeEffort';
  const participants = resolveParticipants(state, conversationId, { user: t('user'), assistant: t('assistant'), parent: t('parentAgent') });
  const agentSender = senderOf({ role: 'assistant' }, participants);
  const historyFormat = readText(conversation.history_format);
  // 続く同じ送り主の発言は名前を 1 回だけ出す。区切り線は流れを切る。承認はエージェントの列に属する。
  let previous: string | undefined;
  function nameShown(sender: Sender | undefined): boolean {
    const shown = sender ? sender.key !== previous : false;
    previous = sender?.key;
    return shown;
  }
  return <section className={`conversation-page${embedded ? ' embedded' : ''}`} aria-label={t('conversation')}>
    <header className="conv-header">
      <div className="conv-title-row" onClick={event => {
        if (!(event.target instanceof Element) || !event.target.closest('.state-badge')) return;
        event.preventDefault(); setDetailsOpen(true);
      }}>
        <Heading className="conv-title truncate" title={title}>{title}</Heading>
        <StateBadge state={status} language={language} evidenceUrl="#conversation-details"
          evidence={evidenceLabel(evidence) || undefined}
          reason={readText(run?.cause ?? run?.reason) || undefined} elapsed={elapsed ? `${t(status.startsWith('waiting') ? 'waiting' : 'elapsed')} ${elapsed}` : undefined}/>
        {provider && <span className="conv-agent truncate" title={[providerName(provider), shownModel].filter(Boolean).join(' · ')}>{agentName(provider, shownModel)}</span>}
        <span className="spacer"/>
        <button type="button" className="btn btn-ghost btn-sm conv-details-toggle" aria-expanded={detailsOpen} aria-controls="conversation-details"
          onClick={() => setDetailsOpen(value => !value)}>{t('details')}<Icon name="chevronDown" size={14} className="caret"/></button>
      </div>
      {detailsOpen && <section id="conversation-details" className="conv-details" aria-label={t('details')}>
        <dl className="conv-meta">
          <div><dt>{t('model')}</dt><dd>{shownModel ? modelName(shownModel) : <span className="muted-text">{t('noModel')}</span>}</dd></div>
          <div><dt>{t('effort')}</dt><dd>{shownEffort || <span className="muted-text">{t('defaultEffort')}</span>}</dd></div>
          <div title={worktree?.full || t('worktree')}><dt>{t('worktree')}</dt><dd className="meta-item"><Icon name="branch" size={14}/>
            {worktree ? <><span className="truncate mono">{worktree.place}</span>{worktree.branch && <span className="branch-name mono">{worktree.branch}</span>}</>
              : <span className="muted-text">{t('noWorktree')}</span>}</dd></div>
          {external && <div><dt>{t('access')}</dt><dd className="meta-item"><span>{t('readOnly')}</span>{!supported && <span className="muted-text">{t('handoffUnsupported')}</span>}</dd></div>}
          {reasonText(run?.cause ?? run?.reason) && <div><dt>{t('reason')}</dt><dd>{reasonText(run?.cause ?? run?.reason)}</dd></div>}
          {readText(run?.last_evidence_ts) && <div><dt>{t('lastEvidence')}</dt><dd><RelativeTime value={readText(run?.last_evidence_ts)} now={now} language={language}/></dd></div>}
        </dl>
      </section>}
    </header>
    <div className="conv-timeline" ref={timeline} aria-label={t('conversation')} tabIndex={0}
      onScroll={event => { if (nearBottom(event.currentTarget)) following.current = true; }}
      onWheel={userScrolled} onTouchMove={userScrolled} onKeyDown={userScrolled} onPointerUp={userScrolled}><div className="conv-timeline-inner" ref={inner}>
      {anchorId && <AppLink to={`/c/${encodeURIComponent(conversationId)}`}>Latest</AppLink>}
      {historyLoading && <p role="status" className="status-line">Loading messages…</p>}
      {historyError && <p role="alert" className="status-line danger">{historyError} <button className="btn btn-secondary btn-sm" onClick={() => setHistoryRevision(value => value + 1)}>Retry</button></p>}
      {(detail?.hasOlder || messageEntries.length > shownMessages.size) && <button className="btn btn-secondary btn-sm" disabled={historyLoading} onClick={() => { following.current = false; if (detail?.hasOlder) void loadHistory(true); else setMessageLimit(value => value + MESSAGE_PAGE_SIZE); }}>Load older</button>}
      {!historyLoading && !historyError && entries.length === 0 && deltas.length === 0 && <p className="timeline-empty"><Icon name="message" size={16}/>{t('empty')}</p>}
      {groupToolRuns(entries).map(entry => {
        if (entry.kind === 'tools') {
          // 続く道具の呼び出しは 1 行に畳み、開くと 1 つずつ見られる。
          const count = countTools(entry.rows.map(item => item.row));
          return <details className="tool-run" key={entry.key}>
            <summary><Icon name="terminal" size={13}/>{count === 1 ? 'Used 1 tool' : `Used ${count} tools`}</summary>
            <div className="tool-run-body">{entry.rows.map(item => <Message key={item.key} row={item.row} sender={agentSender} showName={false} language={language} toolResults={toolResults}/>)}</div>
          </details>;
        }
        if (entry.kind === 'message') {
          const sender = senderOf(entry.row, participants);
          return <Message key={entry.key} row={entry.row} sender={sender} showName={nameShown(sender)} language={language} toolResults={toolResults}/>;
        }
        if (entry.kind === 'approval') return <ApprovalCard screen={historyState} key={entry.key} entry={entry} t={t} disabled={!writable} answered={answered.has(entry.row.id)} onAnswer={decision => void answer(entry.row.id, decision)}/>;
        nameShown(undefined);
        return <div role="separator" className={`timeline-boundary${entry.kind === 'gap' ? ' gap' : ''}${entry.row.confidence === 'inferred' ? ' inferred' : ''}`} key={entry.key}>
          {entry.row.series ? <span>Conversation continued</span> : entry.kind === 'gap' ? <>{t('missing')}: {showValue(entry.row.from_ts ?? entry.row.from)} – {showValue(entry.row.to_ts ?? entry.row.to)} {readText(entry.row.reason)}</>
            : <>{t(entry.row.type as ConversationText)} · {nameOf(state, entry.row.from_id)} → {nameOf(state, entry.row.to_id)}</>}
          {!entry.row.series && <TimeStamp value={entry.time} fallback={t('timeUnknown')}/>}
        </div>;
      })}
      {deltas.map(([key, delta]) => <Message key={key} language={language} streaming sender={agentSender} showName={nameShown(agentSender)}
        row={{ id: delta.messageId ?? key, role: 'assistant', body: delta.text, body_state: 'stored' } satisfies Row}/>)}
      {rawStatus === 'running' && lastHuman && Number.isFinite(Date.parse(lastHuman.time)) && <p className="working-line" role="status">
        <span className="pulse" aria-hidden="true"/>{language === 'ja' ? '作業中' : 'Working'}… {formatSeconds(Math.max(0, Math.floor((now - Date.parse(lastHuman.time)) / 1000)))}
        {lastTool && <span className="working-tool"> · {lastTool}</span>}</p>}
    </div></div>
    {/* 端末で動いている会話は、返信の場所と、ここで続ける操作だけを入力欄に出す。押すと通常の入力欄になる。 */}
    {external && !continueHere && <footer className="composer composer-terminal">
      <div className="composer-box readonly composer-terminal-box">
        <p className="composer-terminal-note">{language === 'ja' ? 'この会話はターミナルで動いています。返信はターミナルで行えます。' : 'This conversation is running in your terminal. Reply there, or continue it here.'}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setContinueHere(true)}>{language === 'ja' ? 'ここで続ける' : 'Continue here'}</button>
      </div>
    </footer>}
    {(!external || continueHere) && <footer className="composer" onFocusCapture={() => setEngaged(true)} onPointerDownCapture={() => setEngaged(true)}>
      {(error || pending || nextConversation || modelsError && engaged || handoffBlocked) && <div className="composer-status">
        {error && <p role="alert" className="status-line danger"><Icon name="alert" size={14}/>{error}</p>}
        {pending && <p role="status" className="status-line">{t('pending')}</p>}
        {modelsError && engaged && <p role="alert" className="status-line danger">{modelsError}</p>}
        {handoffBlocked && <p role="alert" className="banner banner-warning"><Icon name="alert" size={14}/>{t('unsupported')}</p>}
        {nextConversation && <AppLink className="status-line" to={`/c/${encodeURIComponent(nextConversation)}`}>{conversationName(state, nextConversation) ? `${t('conversation')}: ${conversationName(state, nextConversation)}` : 'Open conversation'}</AppLink>}
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
      {(engaged && (!model || !cwd.trim()) || provider === 'codex') && <p className="composer-hint">{provider === 'codex' && <span>{t(hint)}</span>}{engaged && (!model || !cwd.trim()) && <span>{t('launchReady')}</span>}</p>}
    </footer>}
  </section>;
}

export default ConversationPage;
