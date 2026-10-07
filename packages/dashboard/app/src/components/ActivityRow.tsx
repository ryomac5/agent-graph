import { Link } from 'react-router';
import type { ReactNode } from 'react';
import type { Language } from '../lib/i18n.ts';
import { evidenceLabel } from '../lib/format.ts';
import { StateBadge } from './StateBadge.tsx';
import { readBody, readText, summarizeChanges, type Activity } from './activity.ts';
import { formatDuration, RelativeTime } from './RelativeTime.tsx';

export const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
export function providerName(provider: string): string { return PROVIDER_NAMES[provider] ?? provider; }

export function AgentCell({ provider, model, effort, language = 'en' }: { provider: string; model: string; effort?: string; language?: Language }) {
  return <span className="agent-cell">
    {provider && <span className={`provider-mark provider-${provider}`}>{providerName(provider)}</span>}
    {model ? <span className="agent-model" title={model}>{model}</span>
      : <span className="muted-text" title={language === 'ja' ? 'モデルの記録がありません' : 'No model recorded for this run'}>{language === 'ja' ? 'モデル未記録' : 'No model recorded'}</span>}
    {effort && <span className="chip chip-quiet">{effort}</span>}
  </span>;
}

export function ActivityRow({ activity, now, language = 'en', onSelect, selected = false, actions, variant = 'table' }: {
  activity: Activity; now: number; language?: Language; onSelect?: () => void; selected?: boolean; actions?: ReactNode; variant?: 'table' | 'list';
}) {
  const ja = language === 'ja';
  const run = activity.run;
  const url = activity.conversationId ? `/c/${encodeURIComponent(activity.conversationId)}` : `/p/${encodeURIComponent(activity.project)}`;
  const elapsed = formatDuration(run?.started_ts, run?.ended_ts, now);
  const waiting = activity.state === 'waiting_approval' || activity.state === 'waiting_input';
  const statusElapsed = waiting ? formatDuration(run?.last_evidence_ts, undefined, now) : elapsed;
  const excerpt = activity.messages.at(-1);
  const changes = summarizeChanges(activity.artifacts);
  const badge = <StateBadge state={activity.state} language={language} evidenceUrl={url}
    evidence={evidenceLabel(activity.state === 'ended' ? run?.end_evidence : run?.last_evidence) || undefined}
    evidenceTime={<RelativeTime value={readText(run?.last_evidence_ts)} now={now} language={language}/>} reason={readText(run?.cause ?? run?.reason) || undefined}
    elapsed={statusElapsed === 'Unknown' ? undefined : statusElapsed}/>;
  const title = <div className="activity-title">
    {onSelect ? <button className="activity-name" aria-current={selected ? 'true' : undefined} onClick={onSelect}>{activity.name}</button>
      : <Link className="activity-name" to={url}>{activity.name}</Link>}
    {activity.provisional && <span className="chip chip-dashed">{ja ? '仮の名前' : 'Provisional'}</span>}
  </div>;
  const summary = <p className="activity-excerpt">{excerpt ? readBody(excerpt.body) || readText(excerpt.body_state) : <span className="muted-text">{ja ? '発言はまだありません' : 'No messages yet'}</span>}</p>;
  if (variant === 'list') {
    return <article className={`activity-item${selected ? ' selected' : ''}`} aria-label={activity.name}>
      <div className="activity-item-head">{title}{actions && <div className="row-actions">{actions}</div>}</div>
      <div className="activity-item-meta">{badge}<AgentCell provider={activity.provider} model={activity.model} effort={activity.effort} language={language}/></div>
      {summary}
    </article>;
  }
  return <article className="activity-row" aria-label={activity.name}>
    <div className="cell cell-name">{title}{summary}</div>
    <div className="cell cell-state">{badge}</div>
    <div className="cell cell-agent"><AgentCell provider={activity.provider} model={activity.model} effort={activity.effort} language={language}/></div>
    <div className="cell cell-elapsed numeric" title={ja ? '経過' : 'Elapsed'}>{elapsed === 'Unknown' ? <span className="muted-text">—</span> : elapsed}</div>
    <div className="cell cell-changes numeric">{changes ?? <span className="muted-text" title={ja ? '成果物はまだありません' : 'No artifact recorded yet'}>—</span>}</div>
    <div className="cell cell-actions">{actions}</div>
  </article>;
}
