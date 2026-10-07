import { useState } from 'react';
import { AppLink } from '../AppLink.tsx';
import { Icon } from '../Icon.tsx';
import { LARGE_FILE_LINES, pairLines, type Attribution, type DiffFile, type DiffLayout, type DiffLine, type LineLocation } from './model.ts';
import './diff.css';

const ATTRIBUTION = {
  confirmed: { label: 'Confirmed', icon: 'check', style: 'chip-accent' },
  inferred: { label: 'Inferred', icon: 'branch', style: 'chip-dashed' },
  joint: { label: 'Joint', icon: 'fork', style: '' },
  unknown: { label: 'Unknown', icon: 'unknown', style: 'chip-dashed' },
} as const;
export function AttributionBadge({ attribution, evidenceUrl }: { attribution: Attribution; evidenceUrl: string }) {
  const item = ATTRIBUTION[attribution];
  return <AppLink className={`chip ${item.style}`} to={evidenceUrl}
    title={attribution === 'unknown' ? 'Changes whose author could not be identified' : `${item.label} attribution · Open evidence`}>
    <Icon name={item.icon} size={12}/>{item.label}</AppLink>;
}
export interface DiffViewProps {
  files: DiffFile[]; layout: DiffLayout; attribution: Attribution; evidenceUrl: string;
  onSelectLine?: (location: LineLocation, extend: boolean) => void;
  selection?: LineLocation; selectedFile?: string;
  /** 差分のファイル名から Files の該当の位置へ移る先。 */
  fileHref?: (path: string) => string;
}
function FileDiff({ file, layout, attribution, evidenceUrl, selection, onSelectLine, selectedFile, fileHref }: DiffViewProps & { file: DiffFile }) {
  const [expanded, setExpanded] = useState(file.lines.length <= LARGE_FILE_LINES);
  function cell(line: DiffLine | undefined, side?: 'old' | 'new') {
    if (!line) return <td className="diff-cell diff-empty"/>;
    const number = side === 'old' ? line.oldLine : side === 'new' ? line.newLine : line.newLine ?? line.oldLine;
    const selectedSide = side ?? (line.newLine === undefined ? 'old' : 'new');
    const selected = selection?.file === file.path && selection.side === selectedSide && number !== undefined
      && number >= selection.startLine && number <= selection.endLine;
    return <td className={`diff-cell diff-${line.kind}${selected ? ' diff-selected' : ''}`}>
      <div className="diff-content">
        {side ? <span className="diff-number">{number}</span> : <><span className="diff-number">{line.oldLine}</span><span className="diff-number">{line.newLine}</span></>}
        <span className="diff-sign" aria-label={line.kind === 'add' ? 'Added' : line.kind === 'remove' ? 'Removed' : undefined}>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
        {onSelectLine && number !== undefined ? <button className="diff-code" aria-pressed={selected}
          aria-label={`Comment on ${file.path} ${selectedSide} line ${number}`}
          onClick={event => onSelectLine({ file: file.path, side: selectedSide, startLine: number, endLine: number }, event.shiftKey)}>{line.text || ' '}</button>
          : <code className="diff-code">{line.text || ' '}</code>}
        {number !== undefined && <AttributionBadge attribution={attribution} evidenceUrl={evidenceUrl}/>}
      </div>
    </td>;
  }
  return <article className={`diff-file${selectedFile === file.path ? ' diff-file-selected' : ''}`} aria-label={`Diff for ${file.path}`}>
    <header className="diff-file-header"><button className="btn btn-ghost btn-sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14}/><Icon name="file" size={14}/>{file.path}</button>
      {fileHref && <AppLink className="btn btn-link btn-sm" to={fileHref(file.path)} title={`Open ${file.path} in Files`} aria-label={`Open ${file.path} in Files`}><Icon name="external" size={12}/>Files</AppLink>}
      <span className="diff-stat"><span className="diff-add-count">+{file.additions}</span> <span className="diff-remove-count">−{file.deletions}</span></span>
      <AttributionBadge attribution={attribution} evidenceUrl={evidenceUrl}/></header>
    {expanded ? <div className="diff-scroll"><table className={`diff-table diff-${layout}`} aria-label={`${file.path} ${layout} diff`}>
      {layout === 'split' && <thead><tr><th>Before</th><th>After</th></tr></thead>}
      <tbody>{layout === 'unified' ? file.lines.map((line, index) => <tr key={index}>{cell(line)}</tr>) : pairLines(file.lines).map(([old, next], index) =>
        <tr key={index}>{old?.kind === 'meta' ? <td colSpan={2} className="diff-meta"><code>{old.text}</code></td> : <>{cell(old, 'old')}{cell(next, 'new')}</>}</tr>)}</tbody>
    </table></div> : <p className="diff-folded muted-text">{file.lines.length > LARGE_FILE_LINES ? 'Large file collapsed initially.' : 'File collapsed.'} Expand to view {file.lines.length} lines.</p>}
  </article>;
}
export function DiffView(props: DiffViewProps) {
  return <div className="diff-view">{props.files.map(file => <FileDiff key={file.path} {...props} file={file}/>)}</div>;
}
