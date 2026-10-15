import { AppLink } from './AppLink.tsx';
import type { ReactNode } from 'react';
import { dictionaries, type Language } from '../lib/i18n.ts';
import { reasonText } from '../lib/reasons.ts';

export type ExecutionState = 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'idle' | 'ended' | 'failed' | 'unknown' | 'stopped' | 'closed' | 'not_hosted' | 'unresolved';
const KNOWN = new Set<ExecutionState>(['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'ended', 'failed', 'unknown', 'stopped', 'closed', 'not_hosted', 'unresolved']);
/** 実行中、承認待ち、返答待ち、失敗、完了を別の色で示す。 */
export function stateTone(state: string): 'running' | 'waiting' | 'input' | 'completed' | 'idle' | 'failed' {
  if (state === 'running' || state === 'starting') return 'running';
  if (state === 'waiting_approval') return 'waiting';
  if (state === 'waiting_input') return 'input';
  if (state === 'ended') return 'completed';
  if (state === 'failed') return 'failed';
  return 'idle';
}
export function toDisplayState(state: string): ExecutionState {
  if (KNOWN.has(state as ExecutionState)) return state as ExecutionState;
  if (['assigned', 'verifying', 'reviewing'].includes(state)) return 'running';
  if (['received', 'accepted'].includes(state)) return 'starting';
  if (state === 'done' || state === 'interrupted') return 'ended';
  if (state === 'denied') return 'failed';
  return 'unknown';
}
const LABELS: Record<string, string> = { running: 'Working', starting: 'Working', waiting_approval: 'Needs approval', waiting_input: 'Waiting',
  idle: 'Idle', unknown: 'Unknown', stopped: 'Stopped', closed: 'Closed', not_hosted: 'Not hosted', unresolved: 'Unresolved', ended: 'Stopped' };
export function stateLabel(state: string, language: Language = 'en'): string {
  const shown = toDisplayState(state);
  return language === 'en' ? LABELS[shown] ?? 'Unknown' : (dictionaries[language] as Record<string, string>)[shown] ?? LABELS[shown] ?? 'Unknown';
}
/** 小さな色の点と短い語で状態を出す。 */
export function StatusDot({ state, language = 'en', className = '', dotOnly = false, dotLabel, activity = false }: { state: string; language?: Language; className?: string; dotOnly?: boolean; dotLabel?: string; activity?: boolean }) {
  const shown = toDisplayState(state);
  const label = activity && shown === 'running' ? dictionaries[language].working : stateLabel(shown, language);
  return <span className={`status status-${stateTone(shown)} ${activity ? 'activity-mark' : ''} ${className}`.trim()} data-state={shown} title={label}><span className="status-dot" aria-hidden={dotLabel ? undefined : true} role={dotLabel ? 'img' : undefined} aria-label={dotLabel}/>{(!dotOnly || activity) && <span className="status-label" aria-hidden={dotOnly || undefined} data-label={label}>{dotOnly ? undefined : label}</span>}</span>;
}
interface StateBadgeProps {
  state: ExecutionState;
  language?: Language;
  evidenceUrl: string;
  evidence?: string;
  evidenceTime?: ReactNode;
  reason?: string;
  elapsed?: string;
  detailed?: boolean;
}
// 状態は点と語で示す。理由と経過は title に置き、行には出さない。失敗だけは理由を短く添える。
export function StateBadge({ state, language = 'en', evidenceUrl, reason, elapsed }: StateBadgeProps) {
  const t = dictionaries[language];
  reason = reasonText(reason) || undefined;
  reason = reason === 'Unknown' || reason === t.unknown ? undefined : reason;
  const label = stateLabel(state, language);
  const title = [label, ['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) ? elapsed : undefined,
    ['unknown', 'failed'].includes(state) ? reason : undefined].filter(Boolean).join(' · ');
  return <AppLink className={`state-badge status status-${stateTone(state)} status-${state}`} to={evidenceUrl} aria-label={`${label} · ${t.evidence}`} title={title}>
    <span className="status-dot" aria-hidden="true"/>
    <span className="state-label">{label}</span>
    {['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) && elapsed && <span className="state-detail">{elapsed}</span>}
    {state === 'failed' && reason && <span className="state-detail">{reason}</span>}
  </AppLink>;
}
