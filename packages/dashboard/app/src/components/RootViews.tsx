import { Link } from 'react-router';
import type { Root } from '../lib/roots.ts';
import type { DelegationTree, TreeNode } from '../pages/tree/model.ts';
import './roots.css';

export function RootList({ roots, selected, onSelect, project }: { roots: Root[]; selected?: string; onSelect?: (root: Root) => void; project?: string }) {
  return <div className="root-list">{roots.map(root => {
    const content = <><strong>{root.name}</strong><span className={`root-state state-${root.state}`}>{root.state}</span>
      <time dateTime={root.last_activity_ts ?? undefined} title={root.last_activity_ts ?? undefined}>{root.last_activity_ts ? new Date(root.last_activity_ts).toLocaleString('en') : 'Activity unknown'}</time>
      <span>{root.running_children} running · {root.total_children} total</span></>;
    return onSelect ? <button key={root.id} className="root-row activity-name" aria-pressed={selected === root.id} onClick={() => onSelect(root)}>{content}</button>
      : <Link key={root.id} className="root-row activity-name" to={`/p/${encodeURIComponent(project ?? root.project ?? 'other')}?root=${encodeURIComponent(root.id)}`}>{content}</Link>;
  })}{!roots.length && <p className="empty-row">No root conversations yet</p>}</div>;
}
export function RootTree({ tree, selected, onSelect, runningOnly = false }: { tree: DelegationTree; selected?: string; onSelect: (node: TreeNode) => void; runningOnly?: boolean }) {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const descriptions = new Map(tree.edges.map(edge => [edge.target, edge]));
  function branch(id: string, ancestors = new Set<string>()): React.ReactNode {
    const node = byId.get(id);
    if (!node || ancestors.has(id)) return null;
    const next = new Set([...ancestors, id]);
    const children = node.children.map(child => branch(child, next));
    const shown = !runningOnly || ['running', 'starting', 'assigned', 'verifying', 'reviewing'].includes(node.state);
    if (!shown && !children.some(Boolean)) return null;
    const edge = descriptions.get(id);
    return <li key={id}>{(shown || node.role === 'planner' && children.some(Boolean)) && <div className={`root-tree-row${edge?.confidence === 'inferred' ? ' inferred' : ''}`}>
      {node.role === 'planner' && !node.conversationId ? <h3>{node.label}</h3> : <button className="delegation-select" title={node.label} aria-pressed={selected === id} onClick={() => onSelect(node)}>{node.label}</button>}
      {!runningOnly && edge?.title && <p title={edge.title}>{edge.title}</p>}
    </div>}{children.some(Boolean) && <ul>{children}</ul>}</li>;
  }
  const children = tree.nodes.find(node => node.id === tree.roots[0])?.children ?? [];
  return <div className="root-tree"><ul>{children.map(id => branch(id))}</ul>{!children.length && <p className="empty-row">No delegations yet</p>}</div>;
}
