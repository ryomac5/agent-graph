import { executionStates } from '../../components/activity.ts';
import { StateBadge, type ExecutionState } from '../../components/StateBadge.tsx';
import { evidenceLabel, formatSeconds } from '../../lib/format.ts';
import type { Language } from '../../lib/i18n.ts';
import type { TreeNode } from './model.ts';

export function NodeSummary({ node, language = 'en' }: { node: TreeNode; language?: Language }) {
  const ja = language === 'ja';
  const state = executionStates.includes(node.state as ExecutionState) ? node.state as ExecutionState
    : node.state === 'done' ? 'ended' : node.state === 'accepted' || node.state === 'received' ? 'idle' : 'unknown';
  const run = node.run;
  const start = Date.parse(String(run?.last_evidence_ts ?? run?.started_ts ?? ''));
  const elapsed = Number.isFinite(start) ? formatSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000))) : undefined;
  return <div className="delegation-summary">
    <span>{node.role} · {node.model || (ja ? 'モデルの記録なし' : 'Model not recorded')}</span>
    <StateBadge state={state} language={language}
      evidenceUrl={node.conversationId ? `/c/${encodeURIComponent(node.conversationId)}#evidence` : '#delegation-evidence'}
      evidence={evidenceLabel(run?.end_evidence ?? run?.last_evidence) || undefined}
      evidenceTime={typeof run?.last_evidence_ts === 'string' ? run.last_evidence_ts : undefined}
      reason={typeof (run?.cause ?? run?.reason) === 'string' ? String(run?.cause ?? run?.reason) : undefined} elapsed={elapsed}/>
    <span>{ja ? '試行' : 'Attempts'} · {node.delegation ? Number(node.delegation.attempt ?? node.attempts.length) : node.kind === 'run' ? 1 : '—'}
      {' · '}{ja ? '費用' : 'Cost'} · {node.cost === undefined ? (ja ? '不明' : 'Unknown') : `$${node.cost.toFixed(2)}`}</span>
  </div>;
}
