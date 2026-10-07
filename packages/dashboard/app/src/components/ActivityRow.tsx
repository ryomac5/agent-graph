import { Link } from 'react-router';
import type { ReactNode } from 'react';
import type { Language } from '../lib/i18n.ts';
import { StateBadge } from './StateBadge.tsx';
import { readBody, readObject, readText, summarizeChanges, type Activity } from './activity.ts';
import { formatDuration, RelativeTime } from './RelativeTime.tsx';

export function ActivityRow({ activity, now, language = 'en', onSelect, actions }: {
  activity: Activity; now: number; language?: Language; onSelect?: () => void; actions?: ReactNode;
}) {
  const run = activity.run;
  const evidence = readObject(activity.state === 'ended' ? run?.end_evidence : run?.last_evidence);
  const url = activity.conversationId ? `/c/${encodeURIComponent(activity.conversationId)}` : `/p/${encodeURIComponent(activity.project)}`;
  const elapsed = formatDuration(run?.started_ts, run?.ended_ts, now);
  const waiting = activity.state === 'waiting_approval' || activity.state === 'waiting_input';
  const statusElapsed = waiting ? formatDuration(run?.last_evidence_ts, undefined, now) : elapsed;
  const excerpt = activity.messages.at(-1);
  return <article className="activity-row" aria-label={activity.name}>
    <div className="activity-title">{onSelect ? <button onClick={onSelect}>{activity.name}</button> : <Link to={url}>{activity.name}</Link>}
      {activity.provisional && <small>{language === 'ja' ? '仮の名前' : 'Provisional name'}</small>}</div>
    <StateBadge state={activity.state} language={language} evidenceUrl={url}
      evidence={readText(evidence.kind) || readText(evidence.fact_id) || readText(run?.end_evidence) || undefined}
      evidenceTime={<RelativeTime value={readText(run?.last_evidence_ts)} now={now} language={language}/>} reason={readText(run?.cause ?? run?.reason) || undefined} elapsed={statusElapsed}/>
    {activity.state === 'unknown' && <span>{language === 'ja' ? '最後の根拠' : 'Last evidence'}: <RelativeTime value={readText(run?.last_evidence_ts)} now={now} language={language}/></span>}
    <span>{activity.provider} · {activity.model}</span><span>{language === 'ja' ? '経過' : 'Elapsed'}: {elapsed}</span>
    <p className="activity-excerpt">{excerpt ? readBody(excerpt.body) || readText(excerpt.body_state) : language === 'ja' ? '発言はまだありません' : 'No messages yet'}</p>
    <span>{language === 'ja' ? '変更' : 'Changes'}: {summarizeChanges(activity.artifacts)}</span>{actions}
  </article>;
}
