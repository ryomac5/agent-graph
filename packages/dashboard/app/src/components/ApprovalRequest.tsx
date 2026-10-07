import { approvalOutcome, readApprovalRequest, splitPath, type ApprovalOutcome } from '../lib/format.ts';
import type { Row } from '../lib/store.ts';
import { Fields } from './Fields.tsx';
import { Icon, type IconName } from './Icon.tsx';

export function DiffView({ diff, label = 'Expanded file diff' }: { diff: string; label?: string }) {
  const lines = diff.split('\n');
  return <pre className="diff-view" aria-label={label}>{lines.map((line, index) => <span key={index}
    className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : undefined}>
    {index < lines.length - 1 ? `${line}\n` : line}</span>)}</pre>;
}

/** 承認の要求の中身。コマンドは全文、ファイルの変更は差分で 1 度だけ出す。 */
export function ApprovalRequestView({ request, compact = false }: { request: unknown; compact?: boolean }) {
  const parsed = readApprovalRequest(request);
  return <div className={compact ? 'approval-request compact' : 'approval-request'}>
    {parsed.command !== undefined && <pre className="command-block" aria-label="Full command"><Icon name="terminal" size={14} className="command-prompt"/>{parsed.command}</pre>}
    {parsed.file && <p className="approval-file" title={parsed.file}><Icon name="file" size={14}/><span className="truncate">{splitPath(parsed.file).length > 3 ? `…/${splitPath(parsed.file).slice(-3).join('/')}` : parsed.file}</span></p>}
    {parsed.diff !== undefined && <DiffView diff={parsed.diff}/>}
    {parsed.command === undefined && parsed.diff === undefined && parsed.fields.length > 0 && <Fields value={Object.fromEntries(parsed.fields)}/>}
    {parsed.command === undefined && parsed.diff === undefined && parsed.fields.length === 0 && !parsed.file && <p className="muted-text">Request content unavailable.</p>}
  </div>;
}

// 結果ごとの印。許可はチェック、拒否はばつ、期限切れは時計、待ちは注意の印にする。
export const OUTCOME_ICONS: Record<ApprovalOutcome, IconName> = {
  pending: 'alert', answered: 'alert', allowed: 'check', denied: 'x', expired: 'clock', stale: 'alert', resolved: 'dot',
};
export const OUTCOME_LABELS: Record<ApprovalOutcome, string> = {
  pending: 'Pending', answered: 'Answered', allowed: 'Allowed', denied: 'Denied', expired: 'Expired', stale: 'Stale', resolved: 'Resolved',
};
export function OutcomeIcon({ outcome, size = 14 }: { outcome: ApprovalOutcome; size?: number }) {
  return <Icon name={OUTCOME_ICONS[outcome]} size={size} className={`outcome-icon outcome-${outcome}`} data-outcome={outcome}/>;
}
/** 承認の結果の札。印と文字と色を同じ規則で出す。 */
export function OutcomeChip({ row, answered = false, label }: { row: Row; answered?: boolean; label?: (outcome: ApprovalOutcome) => string }) {
  const outcome = approvalOutcome(row, answered);
  return <span className={`chip outcome-chip outcome-${outcome}`} data-outcome={outcome}><OutcomeIcon outcome={outcome} size={12}/>{label?.(outcome) ?? OUTCOME_LABELS[outcome]}</span>;
}
