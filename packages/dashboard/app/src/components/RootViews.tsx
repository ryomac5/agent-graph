import { Link } from 'react-router';
import type { Root } from '../lib/roots.ts';
import { agentName, formatAgo, formatWhen } from '../lib/format.ts';
import { dictionaries, type Language } from '../lib/i18n.ts';
import type { DelegationTree, TreeNode } from '../pages/tree/model.ts';
import { StatusDot, stateLabel } from './StateBadge.tsx';
import './roots.css';

const ACTIVE = ['running', 'starting', 'assigned', 'verifying', 'reviewing'];
function runningText(count: number, language: Language): string {
  const t = dictionaries[language];
  return language === 'ja' ? `${count} ${t.agentsRunning}` : `${count} ${count === 1 ? t.agentRunning : t.agentsRunning}`;
}

/** 根の会話の 1 行。1 行目に名前と時刻、2 行目に状態と動いているエージェントの数を出す。 */
export function RootList({ roots, selected, onSelect, project, language = 'en' }: { roots: Root[]; selected?: string; onSelect?: (root: Root) => void; project?: string; language?: Language }) {
  const t = dictionaries[language];
  return <div className="root-list">{roots.map(root => {
    const content = <><span className="root-row-line"><strong className="root-name">{root.name}</strong></span>
      <span className="root-row-meta"><StatusDot className="root-state" state={root.state} language={language}/>
        {root.running_children > 0 && <span className="root-running">{runningText(root.running_children, language)}</span>}
        {root.last_activity_ts && <time className="root-time" dateTime={root.last_activity_ts} title={new Date(root.last_activity_ts).toLocaleString()}>{formatWhen(root.last_activity_ts, language)}</time>}</span></>;
    return onSelect ? <button key={root.id} className="root-row activity-name" aria-pressed={selected === root.id} onClick={() => onSelect(root)}>{content}</button>
      : <Link key={root.id} className="root-row activity-name" to={`/p/${encodeURIComponent(project ?? root.project ?? 'other')}?root=${encodeURIComponent(root.id)}`}>{content}</Link>;
  })}{!roots.length && <p className="empty-row">{t.noConversations}</p>}</div>;
}

function lastActivity(node: TreeNode): string {
  const run = node.run;
  return String(run?.last_evidence_ts ?? run?.ended_ts ?? run?.started_ts ?? '');
}

/** 依頼の流れ。根を頂点に置き、頼んだ内容を 1 行目、依頼先と状態と時刻を 2 行目に出す。子の子は字下げで続ける。 */
export function RootTree({ tree, selected, onSelect, runningOnly = false, language = 'en', root, onSelectRoot, onRetry }: {
  tree: DelegationTree; selected?: string; onSelect: (node: TreeNode) => void; runningOnly?: boolean; language?: Language;
  root?: { name: string; state: string }; onSelectRoot?: () => void; onRetry?: (node: TreeNode) => void;
}) {
  const t = dictionaries[language];
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const descriptions = new Map(tree.edges.map(edge => [edge.target, edge]));
  function branch(id: string, ancestors = new Set<string>()): React.ReactNode {
    const node = byId.get(id);
    if (!node || ancestors.has(id)) return null;
    const next = new Set([...ancestors, id]);
    const children = node.children.map(child => branch(child, next));
    const shown = !runningOnly || ACTIVE.includes(node.state);
    if (!shown && !children.some(Boolean)) return null;
    const edge = descriptions.get(id);
    const who = agentName(node.provider, node.model) || t.agent;
    const title = edge?.title || [who, node.role].filter(Boolean).join(' · ');
    const when = formatAgo(lastActivity(node), language);
    const group = node.role === 'planner' && !node.conversationId;
    const isSelected = selected === id || Boolean(selected) && node.conversationId === selected;
    const retry = onRetry && node.delegation && String(node.delegation.state ?? node.state) === 'failed';
    return <li key={id}>{(shown || group && children.some(Boolean)) && (group
      ? <h3 className="request-group">{node.label}</h3>
      : <div className={`request-row${isSelected ? ' selected' : ''}`}>
        <button className="request-main delegation-select" title={title} aria-label={[edge?.title, [who, node.role].filter(Boolean).join(' · '), stateLabel(node.state, language)].filter(Boolean).join(' · ')} aria-pressed={isSelected} onClick={() => onSelect(node)}>
          <span className="request-title">{title}</span>
          <span className="request-meta"><StatusDot state={node.state} language={language}/><span className="request-who">{[who, node.role].filter(Boolean).join(' · ')}</span>{when && <span className="request-when">{when}</span>}</span>
        </button>
        {retry && <button className="btn btn-ghost btn-xs request-retry" onClick={() => onRetry(node)}>{t.retry}</button>}
      </div>)}{children.some(Boolean) && <ul>{children}</ul>}</li>;
  }
  const children = tree.nodes.find(node => node.id === tree.roots[0])?.children ?? [];
  const items = children.map(id => branch(id));
  const empty = !items.some(Boolean);
  if (root) return <div className="root-tree request-flow"><ul><li>
    <div className={`request-row request-apex${selected ? '' : ' selected'}`}><button className="request-main" aria-pressed={!selected} onClick={onSelectRoot}>
      <span className="request-title">{root.name}</span><span className="request-meta"><StatusDot state={root.state} language={language}/></span></button></div>
    {!empty && <ul>{items}</ul>}</li></ul>{empty && <p className="empty-row">{t.noRequests}</p>}</div>;
  return <div className="root-tree"><ul>{items}</ul>{empty && !runningOnly && <p className="empty-row">{t.noRequests}</p>}</div>;
}
