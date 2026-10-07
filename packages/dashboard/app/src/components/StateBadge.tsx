import { AppLink } from './AppLink.tsx';
import type { ReactNode } from 'react';
import { dictionaries, type Language } from '../lib/i18n.ts';
import { Icon } from './Icon.tsx';

export type ExecutionState = 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'idle' | 'ended' | 'failed' | 'unknown';
interface StateBadgeProps {
  state: ExecutionState;
  language?: Language;
  evidenceUrl: string;
  evidence?: string;
  evidenceTime?: ReactNode;
  reason?: string;
  elapsed?: string;
  /** 会話の見出しでは根拠と時刻も並べる。一覧では印と短い理由だけを 1 行で出す。 */
  detailed?: boolean;
}
// 状態は色だけに頼らず、印と文字で示す。不明は破線の枠と印で示す。
export function StateBadge({ state, language = 'en', evidenceUrl, evidence, evidenceTime, reason, elapsed, detailed = false }: StateBadgeProps) {
  const t = dictionaries[language];
  evidence = state === 'unknown' && evidence && /unknown/i.test(evidence) ? undefined : evidence;
  reason = reason === 'Unknown' || reason === t.unknown ? undefined : reason;
  if (state === 'unknown' && reason) reason = reason.replace(/\bunknown\b/gi, 'unavailable');
  const fullReason = state === 'unknown' && !reason ? (language === 'ja' ? '実行の状態を確認できる根拠がありません' : 'No evidence confirming execution state') : reason;
  if (state === 'unknown' && !reason) reason = language === 'ja' ? '根拠なし' : 'No evidence';
  const label = state === 'starting' ? (language === 'ja' ? '起動中' : 'Starting') : t[state];
  const title = [label, ['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) ? elapsed : undefined,
    ['unknown', 'ended'].includes(state) ? evidence : undefined, ['unknown', 'failed'].includes(state) ? fullReason : undefined].filter(Boolean).join(' · ');
  return <AppLink className={`state-badge status-${state}${detailed ? ' detailed' : ''}`} to={evidenceUrl} aria-label={`${label} · ${t.evidence}`} title={title}>
    {state === 'unknown' ? <Icon name="unknown" size={13}/> : state === 'failed' ? <Icon name="alert" size={13}/> : <span className="state-dot" aria-hidden="true"/>}
    <span className="state-label">{label}</span>
    {['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) && elapsed && <span className="state-detail">{elapsed}</span>}
    {(state === 'ended' || detailed && state === 'unknown') && evidence && <span className="state-detail">{evidence}</span>}
    {detailed && state === 'unknown' && evidenceTime && <span className="state-detail">{evidenceTime}</span>}
    {['unknown', 'failed'].includes(state) && reason && <span className="state-detail">{reason}</span>}
  </AppLink>;
}
