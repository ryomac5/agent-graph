import { formatClock } from '../../lib/format.ts';
import type { FileChange } from '../../lib/conversation-changes.ts';
import type { Language } from '../../lib/i18n.ts';
import { translate } from '../../components/conversation/text.ts';
import { Icon } from '../../components/Icon.tsx';
import '../../components/diff/diff.css';

export function ChangedFiles({ files, language }: { files: FileChange[]; language: Language }) {
  return <section id="conversation-changed-files" className="conv-changed-files" aria-label={translate(language, 'filesChanged')}>
    {files.map(file => <details key={file.path} className="conv-changed-file">
      <summary><Icon name="chevronRight" size={14} className="caret"/><span className="truncate mono" title={file.path}>{file.path}</span>
        <span className="spacer"/><span className="diff-add-count">+{file.additions}</span><span className="diff-remove-count">−{file.deletions}</span></summary>
      {file.changes.map((change, index) => <div key={index} className="conv-file-change">
        <div className="conv-change-meta"><span>{change.tool}</span>{change.time && <time dateTime={change.time} title={change.time}>{formatClock(change.time, language)}</time>}</div>
        <div className="diff-scroll"><table className="diff-table diff-unified" aria-label={`${file.path} ${translate(language, 'difference')}`}><tbody>
          {change.lines.map((line, lineIndex) => <tr key={lineIndex}><td className={`diff-cell diff-${line.kind}`}><div className="diff-content">
            <span className="diff-sign">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><code className="diff-code">{line.text || ' '}</code>
          </div></td></tr>)}
        </tbody></table></div>
      </div>)}
    </details>)}
  </section>;
}
