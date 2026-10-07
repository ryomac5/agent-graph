import { Link } from 'react-router';
import type { ReactNode } from 'react';
import type { Language } from '../lib/i18n.ts';
import { evidenceLabel, providerName } from '../lib/format.ts';
import { StateBadge } from './StateBadge.tsx';
import { readBody, readText, summarizeChanges, type Activity } from './activity.ts';
import { formatDuration, RelativeTime } from './RelativeTime.tsx';

export { PROVIDER_NAMES, providerName } from '../lib/format.ts';

export function AgentCell({ provider, model, effort, language = 'en' }: { provider: string; model: string; effort?: string; language?: Language }) {
  return <span className="agent-cell">
    {provider && <span className={`provider-mark provider-${provider}`}>{providerName(provider)}</span>}
    {/* モデルが記録されていないときは provider だけを出す。記録なしの文言は行ごとに繰り返さない。 */}
    {model ? <span className="agent-model" title={model}>{model}</span>
      : !provider && <span className="muted-text" title={language === 'ja' ? 'エージェントの記録がありません' : 'No agent recorded for this run'}>—</span>}
    {effort && <span className="chip chip-quiet">{effort}</span>}
  </span>;
}

const LIVE_STATES = ['starting', 'running', 'waiting_approval', 'waiting_input'];
/**
 * 経過は状態ごとに起点を変える。動いている間と待ちの間は、その状態の根拠の時刻から数える。
 * 終わった実行は開始から終了まで、待機と不明は経過を出さない。
 */
export function readElapsed(activity: Activity, now: number): string {
  const run = activity.run;
  if (LIVE_STATES.includes(activity.state)) return formatDuration(run?.last_evidence_ts ?? run?.started_ts, undefined, now);
  if (activity.state === 'ended' || activity.state === 'failed') return formatDuration(run?.started_ts, run?.ended_ts, now);
  return 'Unknown';
}
/** 止まっている行は薄く出す。承認と入力の待ちと失敗と不明は薄くしない。 */
export function isStoppedState(state: string): boolean { return state === 'idle' || state === 'ended'; }

export function ActivityRow({ activity, now, language = 'en', onSelect, selected = false, actions, variant = 'table', children }: {
  activity: Activity; now: number; language?: Language; onSelect?: () => void; selected?: boolean; actions?: ReactNode; variant?: 'table' | 'list' | 'compact';
  children?: ReactNode;
}) {
  const ja = language === 'ja';
  const run = activity.run;
  const url = activity.conversationId ? `/c/${encodeURIComponent(activity.conversationId)}` : `/p/${encodeURIComponent(activity.project)}`;
  const elapsed = readElapsed(activity, now);
  const statusElapsed = elapsed;
  // 実行中と待機の行には、最後の根拠の時刻を添える。実行中はターンの途中の最後の記録まで含め、止まったターンを見分けられるようにする。
  const evidenceTs = activity.state === 'running' ? activity.lastActivity || readText(run?.last_evidence_ts)
    : activity.state === 'idle' ? readText(run?.last_evidence_ts) : '';
  const lastEvidence = evidenceTs
    ? <span className="last-evidence">{ja ? '最後の根拠 ' : 'Last evidence '}<RelativeTime value={evidenceTs} now={now} language={language}/></span> : null;
  const stopped = isStoppedState(activity.state);
  const excerpt = activity.messages.at(-1);
  const changes = summarizeChanges(activity.artifacts);
  const badge = <StateBadge state={activity.state} language={language} evidenceUrl={url}
    evidence={evidenceLabel(activity.state === 'ended' ? run?.end_evidence : run?.last_evidence) || undefined}
    evidenceTime={readText(run?.last_evidence_ts) ? <RelativeTime value={readText(run?.last_evidence_ts)} now={now} language={language}/> : undefined} reason={readText(run?.cause ?? run?.reason) || undefined}
    elapsed={statusElapsed === 'Unknown' ? undefined : statusElapsed}/>;
  const title = <div className="activity-title">
    {onSelect ? <button className="activity-name" aria-current={selected ? 'true' : undefined} title={activity.firstRequest || undefined} onClick={onSelect}>{activity.name}</button>
      : <Link className="activity-name" to={url} title={activity.firstRequest || undefined}>{activity.name}</Link>}
    {activity.provisional && <span className="chip chip-dashed">{ja ? '仮の名前' : 'Provisional'}</span>}
  </div>;
  const summary = <p className="activity-excerpt">{excerpt ? readBody(excerpt.body) || readText(excerpt.body_state) : activity.excerpt || <span className="muted-text">{ja ? '発言はまだありません' : 'No messages yet'}</span>}</p>;
  if (variant === 'compact') {
    // 作業場の作業の列は 1 行に収め、会話に高さを渡す。
    return <article className={`activity-line${activity.parentConversationId ? ' activity-child' : ''}${selected ? ' selected' : ''}${stopped ? ' is-stopped' : ''}`} aria-label={activity.name}>
      {title}{summary}{badge}<AgentCell provider={activity.provider} model={activity.model} effort={activity.effort} language={language}/>
      {actions && <div className="row-actions">{actions}</div>}
    </article>;
  }
  if (variant === 'list') {
    return <article className={`activity-item${activity.parentConversationId ? ' activity-child' : ''}${selected ? ' selected' : ''}${stopped ? ' is-stopped' : ''}`} aria-label={activity.name}>
      <div className="activity-item-head">{title}{actions && <div className="row-actions">{actions}</div>}</div>
      <div className="activity-item-meta">{badge}<AgentCell provider={activity.provider} model={activity.model} effort={activity.effort} language={language}/>{lastEvidence}</div>
      {summary}
      {children}
    </article>;
  }
  return <article className={`activity-row${activity.parentConversationId ? ' activity-child' : ''}${stopped ? ' is-stopped' : ''}`} aria-label={activity.name}>
    <div className="cell cell-name">{title}{summary}</div>
    <div className="cell cell-state">{badge}{lastEvidence}</div>
    <div className="cell cell-agent"><AgentCell provider={activity.provider} model={activity.model} effort={activity.effort} language={language}/></div>
    <div className="cell cell-elapsed numeric" title={ja ? '経過' : 'Elapsed'}>{elapsed === 'Unknown' ? <span className="muted-text">—</span> : elapsed}</div>
    <div className="cell cell-changes numeric">{changes ?? <span className="muted-text" title={ja ? '成果物はまだありません' : 'No artifact recorded yet'}>—</span>}</div>
    <div className="cell cell-actions">{actions}</div>
    {children && <div className="cell cell-delegations">{children}</div>}
  </article>;
}
