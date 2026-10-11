import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Icon } from '../../components/Icon.tsx';
import { StatusDot, stateLabel, toDisplayState } from '../../components/StateBadge.tsx';
import { agentName, formatWhen, summarizeApproval } from '../../lib/format.ts';
import type { Language } from '../../lib/i18n.ts';
import { graphText } from '../../lib/i18n.ts';
import type { Row } from '../../lib/store.ts';
import { readObject, readText } from '../../components/conversation/model.ts';
import { getDecision } from '../inbox/model.ts';
import { ROLES, ROLE_ICONS, roleWord, type GraphRow, type GraphRows } from './rows.ts';
import type { ChildRole } from '../../lib/roots.ts';

export function elapsed(row: GraphRow, now: number): string {
  const start = row.segments.at(-1)?.start;
  if (start === undefined) return '';
  const end = ['running', 'starting'].includes(toDisplayState(row.node?.state ?? '')) ? now : row.segments.at(-1)!.end;
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function rowEnd(row: GraphRow, language: Language, now: number): string {
  const ja = language === 'ja'; const node = row.node;
  if (!node) return '';
  if (row.role === 'main' && row.runningBelow) return ja ? `下で ${row.runningBelow} 件が実行中` : `${row.runningBelow} running below`;
  const state = toDisplayState(node.state);
  if (['starting', 'running'].includes(state)) return elapsed(row, now);
  if (state === 'waiting_approval') return ja ? '承認待ち' : 'Approval';
  if (state === 'waiting_input') return ja ? '返答待ち' : 'Your turn';
  if (state === 'failed') return ja ? '失敗' : 'Failed';
  const verdict = String(node.delegation?.verdict ?? (/^Approved/.test(node.report ?? '') ? 'approve' : /^Changes requested/.test(node.report ?? '') ? 'request_changes' : ''));
  if (row.role === 'review' && verdict) return verdict === 'approve' ? (ja ? '合格' : 'Pass') : (ja ? '修正が必要' : 'Changes');
  return formatWhen(node.activity, language);
}
export function GraphSummary({ model, role, onRole, language, embedded }: { model: GraphRows; role?: ChildRole; onRole: (role?: ChildRole) => void; language: Language; embedded: boolean }) {
  const t = graphText[language];
  const roles = ROLES.filter(item => model.roles[item]);
  const visibleRoles = embedded ? roles.slice(0, 2) : roles;
  if (embedded && role && !visibleRoles.includes(role)) visibleRoles.splice(Math.max(0, visibleRoles.length - 1), 1, role);
  const hiddenRoles = roles.filter(item => !visibleRoles.includes(item));
  const button = (item: ChildRole) => <button key={item} className={role === item ? 'is-active' : ''} aria-pressed={role === item} onClick={() => onRole(role === item ? undefined : item)}>{roleWord(item, language)} {model.roles[item]}</button>;
  return <div className={`graph-summary${embedded ? ' is-embedded' : ''}`}>
    <div className="graph-summary-state">{model.running > 0 && <span><StatusDot state="running" dotOnly/>{model.running} {t.running}</span>}{model.needsYou > 0 && <span><StatusDot state="waiting_approval" dotOnly/>{model.needsYou} {t.needsYou}</span>}</div>
    <div className="graph-summary-roles">{visibleRoles.map(button)}{hiddenRoles.length > 0 && <details><summary>+{hiddenRoles.length}</summary><div className="graph-role-menu">{hiddenRoles.map(button)}</div></details>}</div>
  </div>;
}
export interface OutlineProps {
  model: GraphRows; language: Language; selected: string; now: number; embedded: boolean;
  href: (row: GraphRow) => string; onSelect: (row: GraphRow) => void; onGroup: (id: string, action: 'more' | 'close') => void;
  onAnswer: (approval: Row, action: 'allow' | 'deny') => void; sent: ReadonlySet<string>; connected: boolean;
  timeline?: (row: GraphRow) => ReactNode;
}
export function GraphOutline(props: OutlineProps) {
  const { model, language, selected, now, embedded, href, onSelect, onGroup, onAnswer, sent, connected, timeline } = props;
  const navigate = useNavigate();
  const refs = useRef(new Map<string, HTMLElement>());
  const t = graphText[language];
  function move(event: KeyboardEvent, row: GraphRow) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (row.group) onGroup(row.group.groupId ?? row.id, event.key === 'ArrowRight' ? 'more' : 'close');
      else {
        const group = model.rows.find(item => item.group && (event.key === 'ArrowRight' ? item.parent === row.id : item.parent === row.parent));
        if (group) { onGroup(group.id, event.key === 'ArrowRight' ? 'more' : 'close'); refs.current.get(group.id)?.focus(); }
        else if (event.key === 'ArrowLeft' && row.parent) refs.current.get(row.parent)?.focus();
      }
      return;
    }
    const index = model.rows.indexOf(row);
    const next = event.key === 'Home' ? model.rows[0] : event.key === 'End' ? model.rows.at(-1) : model.rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) refs.current.get(next.id)?.focus();
  }
  const offsets = new Map<string, number>(); let height = 0;
  for (const row of model.rows) { offsets.set(row.id, height); height += row.height; }
  return <div className={timeline ? 'graph-timeline-rows' : 'graph-outline'} role="tree" aria-label={t.requests}>
    <svg className="graph-tree-lines" height={height} aria-hidden="true">
      {model.rows.filter(row => row.parent && offsets.has(row.parent)).toSorted((a, b) => Number(a.runningPath) - Number(b.runningPath) || Number(a.selectedPath) - Number(b.selectedPath)).map(row => {
        const parent = model.rows.find(item => item.id === row.parent)!;
        const px = 20 + parent.depth * 16; const py = offsets.get(parent.id)! + 16;
        const cx = 20 + row.depth * 16; const cy = offsets.get(row.id)! + 16;
        return <path key={row.id} className={`graph-branch${row.runningPath ? ' is-running' : row.selectedPath ? ' is-selected' : ''}`} d={`M ${px} ${py + 3} V ${cy} H ${cx - 3}`} data-parent={row.parent} data-child={row.id}/>;
      })}
    </svg>
    {model.rows.map(row => {
      const node = row.node; const state = toDisplayState(node?.state ?? 'idle');
      const running = ['starting', 'running'].includes(state);
      const target = node?.provider === 'codex' ? 'Codex' : agentName(node?.provider ?? '', node?.model ?? '').replace(/^Claude\s*/, '') || 'Claude';
      const groupWords = row.group ? ROLES.filter(role => row.group!.roles[role]).map(role => `${roleWord(role, language)} ${row.group!.roles[role]}`).join(' · ') : '';
      const who = row.group ? groupWords : `${roleWord(row.role!, language)}${row.role === 'main' ? '' : ` · ${target}`}`;
      const title = row.group?.more ? t.showMore : row.group ? `${row.group.kind === 'today' ? t.today : t.earlier} ${row.group.count}` : node!.label;
      const kit = readObject(node?.delegation?.kit ?? readObject(node?.delegation?.payload).kit);
      const task = readText(node?.delegation?.task_id ?? kit.node_id);
      const taskNumber = /^T?\d+$/.test(task) ? `T${task.replace(/^T/, '')}` : '';
      const content = <>
        <span className="graph-indent" style={{ width: `calc(${row.depth} * var(--space-4))` }} aria-hidden="true"/>
        {row.group ? <Icon name={row.group.shown ? 'chevronDown' : 'chevronRight'}/> : <StatusDot state={row.role === 'main' && row.runningBelow && state === 'idle' ? 'running' : node!.state} dotOnly dotLabel={row.role === 'main' && row.runningBelow ? t.running : undefined}/>}
        {!row.group && <span className="graph-role" data-role={row.role} data-icon={ROLE_ICONS[row.role!]}><Icon name={ROLE_ICONS[row.role!]}/></span>}
        <span className="graph-row-title" title={title}>{Boolean(taskNumber) && <span className="graph-task-number">{taskNumber} </span>}{title}</span>
        <span className="graph-row-who" title={who}>{who}</span>
        {node?.inferred && <span className="graph-row-inferred" title={t.inferred}>{t.inferred}</span>}
        {(node?.attempts.length ?? 0) > 1 && <span className="graph-rounds">×{node!.attempts.length}</span>}
        {node && (!timeline || row.role === 'main' && row.runningBelow > 0) && <span className={`graph-row-end state-${state}`} title={rowEnd(row, language, now)}>{rowEnd(row, language, now)}</span>}
      </>;
      const ref = (element: HTMLElement | null) => { if (element) refs.current.set(row.id, element); else refs.current.delete(row.id); };
      const shared = { className: 'graph-row-main', tabIndex: 0, onKeyDown: (event: KeyboardEvent) => move(event, row), ref, 'aria-level': row.depth + 1, role: 'treeitem', 'aria-selected': selected === row.id, 'aria-current': embedded && selected === row.id ? 'page' as const : undefined, 'aria-label': row.group ? `${title} · ${groupWords}` : `${title} · ${roleWord(row.role!, language)}${row.role === 'main' ? '' : ` · ${target}`} · ${row.role === 'main' && row.runningBelow ? rowEnd(row, language, now) : stateLabel(node!.state, language)}` };
      return <div key={row.id} className={`graph-row${running ? ' is-running' : ''}${selected === row.id ? ' is-selected' : ''}${['ended', 'idle'].includes(state) ? ' is-quiet' : ''}${timeline ? ' has-timeline' : ''}`} data-node-id={row.id} style={{ minHeight: row.height }}>
        <div className="graph-tree-cell">
          {row.group ? <button {...shared} aria-expanded={row.group.more ? undefined : row.group.shown > 0} onClick={() => onGroup(row.group!.groupId ?? row.id, row.group!.more || !row.group!.shown ? 'more' : 'close')}>{content}</button>
            : embedded && node?.conversationId ? <Link {...shared} to={href(row)} onClick={() => onSelect(row)}>{content}</Link>
              : <button {...shared} onClick={() => onSelect(row)} onDoubleClick={() => { if (node?.conversationId) navigate(href(row)); }}>{content}</button>}
          {running && <div className="graph-current-work" title={node?.currentWork} style={{ paddingLeft: `calc(${row.depth} * var(--space-4) + var(--space-12))` }}>{node?.currentWork}</div>}
          {node?.approvals?.map(approval => <div key={String(approval.id)} className="graph-approval" style={{ paddingLeft: `calc(${row.depth} * var(--space-4) + var(--space-4))` }}>
            <code title={summarizeApproval(approval.request)}>{summarizeApproval(approval.request)}</code>
            {(['allow', 'deny'] as const).map(action => <button key={action} className="btn btn-ghost btn-sm" disabled={!connected || sent.has(String(approval.id)) || !getDecision(approval, action)} onClick={() => onAnswer(approval, action)}>{action === 'allow' ? t.allow : t.deny}</button>)}
          </div>)}
        </div>
        {timeline?.(row)}
      </div>;
    })}
  </div>;
}
