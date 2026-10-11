import { useRef, useSyncExternalStore } from 'react';
import { readObject, readText } from '../components/conversation/model.ts';
import { formatSeconds } from './format.ts';
import type { Row, ScreenState } from './store.ts';
import { isRunning, selectRoots, type Root } from './roots.ts';
import { getConversation, getRequestedTime, isPending } from '../pages/inbox/model.ts';

export const READ_KEY = 'agent-graph-read-turns';
export const READY_KEY = 'agent-graph-ready-turns';
export const RECENT_KEY = 'agent-graph-recent-conversations';
export const RECENT_LIMIT = 10;
export interface WorkingTurn { runKey: string; state: string; started: number; startEvidence: string }
/** ツールや子の更新では時計を戻さない。承認待ちの間も同じターンの開始を保持する。 */
export function resolveWorkingTurn(run: Row | undefined, humanTime = '', previous?: WorkingTurn): WorkingTurn | undefined {
  const state = readText(run?.state);
  if (!['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state)) return undefined;
  const runKey = JSON.stringify([run?.id, run?.generation]);
  const evidence = readObject(run?.last_evidence);
  const startEvidence = evidence.kind === 'turn_started' || evidence.hook_event_name === 'UserPromptSubmit' ? readText(run?.last_evidence_ts) : '';
  if (previous?.runKey === runKey && Number.isFinite(previous.started) && !(startEvidence && startEvidence !== previous.startEvidence)) {
    return { ...previous, state };
  }
  const human = Date.parse(humanTime);
  const runStarted = Date.parse(readText(run?.started_ts));
  const started = startEvidence ? Date.parse(startEvidence)
    : Number.isFinite(human) && (!Number.isFinite(runStarted) || human >= runStarted) ? human
    : Date.parse(readText(run?.last_evidence_ts ?? run?.started_ts));
  return { runKey, state, started, startEvidence };
}
export function useWorkingTurn(run: Row | undefined, humanTime = ''): WorkingTurn | undefined {
  const previous = useRef<WorkingTurn | undefined>(undefined);
  const turn = resolveWorkingTurn(run, humanTime, previous.current);
  previous.current = turn;
  return turn;
}
export function isWorkingTurn(turn: WorkingTurn | undefined): boolean { return turn?.state === 'running' || turn?.state === 'starting'; }
export function workingElapsed(turn: WorkingTurn | undefined, now: number): string {
  return turn && Number.isFinite(turn.started) ? formatSeconds(Math.max(0, Math.floor((now - turn.started) / 1000))) : '';
}
export interface Turn { id: string; kind: 'approval' | 'input' | 'idle'; conversationId: string; time: string; to: string }
export interface NavigationHistory { read: Record<string, string>; ready: Record<string, string>; recent: string[] }
export function readHistory(): NavigationHistory {
  function readTimes(key: string): Record<string, string> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([, time]) => typeof time === 'string')) : {};
    } catch { return {}; }
  }
  let recent: string[] = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (Array.isArray(value)) recent = [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, RECENT_LIMIT);
  } catch { /* 壊れた履歴は空から始める。 */ }
  return { read: readTimes(READ_KEY), ready: readTimes(READY_KEY), recent };
}
export function rememberConversation(history: NavigationHistory, id: string): NavigationHistory {
  return { ...history, recent: [id, ...history.recent.filter(value => value !== id)].slice(0, RECENT_LIMIT) };
}
export function recordTransitions(previous: Root[], roots: Root[], history: NavigationHistory): NavigationHistory {
  const ready = { ...history.ready };
  const before = new Map(previous.map(root => [root.id, root.state]));
  for (const root of roots) {
    if (root.state !== 'idle') {
      for (const id of root.conversation_ids) delete ready[id];
    } else if (isRunning(before.get(root.id) ?? '') || ['waiting_approval', 'waiting_input'].includes(before.get(root.id) ?? '')) {
      for (const id of root.conversation_ids) ready[id] = root.last_activity_ts ?? new Date().toISOString();
    }
  }
  return { ...history, ready };
}
export function rootHref(root: Root): string {
  return `/p/${encodeURIComponent(root.project ?? 'other')}?root=${encodeURIComponent(root.id)}`;
}
/** 承認と返答待ちは事実から、根の待機は確認した状態の変化と既読から決める。 */
export function selectTurns(state: ScreenState, history: NavigationHistory, roots = selectRoots(state)): Turn[] {
  const turns: Turn[] = (state.projection.approvals ?? []).filter(isPending).map(row => ({
    id: `approval-${row.id}`, kind: 'approval', conversationId: getConversation(row, state),
    time: getRequestedTime(row, state), to: `/inbox?approval=${encodeURIComponent(String(row.id))}`,
  }));
  const latest = new Map<string, Row>();
  for (const run of state.projection.runs ?? []) {
    const id = String(run.conversation_id ?? '');
    if (!latest.has(id) || Number(run.generation ?? 0) >= Number(latest.get(id)?.generation ?? 0)) latest.set(id, run);
  }
  for (const [id, run] of latest) if (run.state === 'waiting_input') turns.push({
    id: `input-${id}`, kind: 'input', conversationId: id,
    time: String(run.last_evidence_ts ?? run.started_ts ?? ''), to: `/c/${encodeURIComponent(id)}`,
  });
  for (const root of roots) {
    if (root.state !== 'idle') continue;
    const unread = root.conversation_ids.filter(id => history.ready[id] && history.read[id] !== history.ready[id]);
    if (unread.length) turns.push({ id: `idle-${root.id}`, kind: 'idle', conversationId: unread.at(-1)!,
      time: history.ready[unread.at(-1)!], to: rootHref(root) });
  }
  return turns.toSorted((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0) || a.id.localeCompare(b.id));
}
export interface TurnSnapshot { navigate?: (to: string) => void; state?: ScreenState; history: NavigationHistory; turns: Turn[] }
const empty: TurnSnapshot = { history: { read: {}, ready: {}, recent: [] }, turns: [] };
let snapshot = empty;
const listeners = new Set<() => void>();
export function publishTurns(value?: TurnSnapshot) { snapshot = value ?? empty; for (const listener of listeners) listener(); }
export function useTurns() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot, () => empty);
}

export function useTurnConversations(): Set<string> {
  const ids = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => JSON.stringify([...new Set(snapshot.turns.map(turn => turn.conversationId))].sort()), () => '[]');
  return new Set(JSON.parse(ids) as string[]);
}
