import { AppLink } from './AppLink.tsx';
import type { ReactNode } from 'react';
import { dictionaries, type Language } from '../lib/i18n.ts';
import { reasonText } from '../lib/reasons.ts';

export type ExecutionState = 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'idle' | 'ended' | 'failed' | 'unknown';
const KNOWN = new Set<ExecutionState>(['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'ended', 'failed', 'unknown']);
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
export function stateLabel(state: string, language: Language = 'en'): string { return dictionaries[language][toDisplayState(state)]; }
/** 小さな色の点と短い語で状態を出す。 */
export function StatusDot({ state, language = 'en', className = '', dotOnly = false, dotLabel }: { state: string; language?: Language; className?: string; dotOnly?: boolean; dotLabel?: string }) {
  const shown = toDisplayState(state);
  return <span className={`status status-${stateTone(shown)} ${className}`.trim()} data-state={shown}><span className="status-dot" aria-hidden={dotLabel ? undefined : true} role={dotLabel ? 'img' : undefined} aria-label={dotLabel}/>{!dotOnly && <span className="status-label">{stateLabel(shown, language)}</span>}</span>;
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
  const label = t[state];
  const title = [label, ['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) ? elapsed : undefined,
    ['unknown', 'failed'].includes(state) ? reason : undefined].filter(Boolean).join(' · ');
  return <AppLink className={`state-badge status status-${stateTone(state)} status-${state}`} to={evidenceUrl} aria-label={`${label} · ${t.evidence}`} title={title}>
    <span className="status-dot" aria-hidden="true"/>
    <span className="state-label">{label}</span>
    {['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) && elapsed && <span className="state-detail">{elapsed}</span>}
    {state === 'failed' && reason && <span className="state-detail">{reason}</span>}
  </AppLink>;
}
