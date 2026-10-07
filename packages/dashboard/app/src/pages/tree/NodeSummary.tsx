import { StateBadge } from '../../components/StateBadge.tsx';
import { providerName } from '../../components/ActivityRow.tsx';
import { evidenceLabel, formatSeconds } from '../../lib/format.ts';
import type { Language } from '../../lib/i18n.ts';
import { toExecutionState, type TreeNode } from './model.ts';

export function NodeSummary({ node, language = 'en' }: { node: TreeNode; language?: Language }) {
  const ja = language === 'ja';
  const state = toExecutionState(node.state);
  const run = node.run;
  const start = Date.parse(String(run?.last_evidence_ts ?? run?.started_ts ?? ''));
  const elapsed = Number.isFinite(start) ? formatSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000))) : undefined;
  return <div className="delegation-summary">
    <span>{node.role} · {[node.provider && providerName(node.provider), node.model].filter(Boolean).join(' ') || (ja ? 'モデルの記録なし' : 'Model not recorded')}</span>
    <StateBadge state={state} language={language}
      evidenceUrl={node.conversationId ? `/c/${encodeURIComponent(node.conversationId)}#evidence` : '#delegation-evidence'}
      evidence={evidenceLabel(run?.end_evidence ?? run?.last_evidence) || undefined}
      evidenceTime={typeof run?.last_evidence_ts === 'string' ? run.last_evidence_ts : undefined}
      reason={typeof (run?.cause ?? run?.reason) === 'string' ? String(run?.cause ?? run?.reason) : undefined} elapsed={elapsed}/>
    <span>{ja ? '試行' : 'Attempts'} · {node.delegation ? (node.attempts.length || Number(node.delegation.attempt ?? 0)) : node.kind === 'run' ? 1 : '—'}
      {' · '}{ja ? '費用' : 'Cost'} · {node.cost === undefined ? (ja ? '不明' : 'Unknown') : `$${node.cost.toFixed(2)}`}</span>
  </div>;
}
