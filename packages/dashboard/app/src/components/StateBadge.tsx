import { AppLink } from './AppLink.tsx';
import type { ReactNode } from 'react';
import { dictionaries, type Language } from '../lib/i18n.ts';

export type ExecutionState = 'starting' | 'running' | 'waiting_approval' | 'waiting_input' | 'idle' | 'ended' | 'failed' | 'unknown';
interface StateBadgeProps {
  state: ExecutionState;
  language?: Language;
  evidenceUrl: string;
  evidence?: string;
  evidenceTime?: ReactNode;
  reason?: string;
  elapsed?: string;
}
export function StateBadge({ state, language = 'en', evidenceUrl, evidence, evidenceTime, reason, elapsed }: StateBadgeProps) {
  const t = dictionaries[language];
  const label = state === 'starting' ? (language === 'ja' ? '起動中' : 'Starting') : t[state];
  return <AppLink className={`state-badge status-${state}`} to={evidenceUrl} aria-label={`${label} · ${t.evidence}`}>
    <span>{label}</span>
    {['starting', 'running', 'waiting_approval', 'waiting_input'].includes(state) && elapsed && <span>{elapsed}</span>}
    {['unknown', 'ended'].includes(state) && <span>{evidence ?? t.unknown}</span>}
    {state === 'unknown' && <span>{evidenceTime ?? t.unknown}</span>}
    {['unknown', 'failed'].includes(state) && <span>{reason ?? t.unknown}</span>}
  </AppLink>;
}
