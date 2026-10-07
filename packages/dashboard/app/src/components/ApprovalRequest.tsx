import { readApprovalRequest, splitPath } from '../lib/format.ts';
import { Fields } from './Fields.tsx';
import { Icon } from './Icon.tsx';

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
