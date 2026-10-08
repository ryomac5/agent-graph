import type { DelegationTree, TreeNode } from '../tree/model.ts';
import { lastActivity } from '../../components/RootViews.tsx';
import { toDisplayState } from '../../components/StateBadge.tsx';

export const NARROW_WIDTH = 720;
const EARLIER_MS = 24 * 60 * 60 * 1000;
const CARD_WIDTH = 264;
const ROOT_WIDTH = 288;
const CARD_HEIGHT = 156;
const APPROVAL_HEIGHT = 264;
const LAYER_GAP = 112;
const ROW_GAP = 28;
export interface GraphNode extends TreeNode { activity?: string; approvalCount?: number; earlier?: { parent: string; count: number } }
export interface GraphTree extends Omit<DelegationTree, 'nodes'> { nodes: GraphNode[] }
export interface PositionedNode { id: string; depth: number; x: number; y: number; width: number; height: number }
export interface GraphLayout { nodes: PositionedNode[]; width: number; height: number; vertical: boolean }

/** 古い枝だけを親ごとに畳み、動いている子孫は残す。 */
export function foldEarlier(tree: GraphTree, expanded: ReadonlySet<string>, now: number, selected?: string): GraphTree {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const old = (id: string, ancestors = new Set<string>()): boolean => {
    const node = byId.get(id);
    if (!node || id === selected || ancestors.has(id) || node.approvalCount) return false;
    const next = new Set([...ancestors, id]);
    if (!node.children.every(child => old(child, next))) return false;
    if (node.role === 'planner' && !node.conversationId) return node.children.length > 0;
    const time = Date.parse(lastActivity(node));
    return ['failed', 'ended', 'idle'].includes(toDisplayState(node.state)) && Number.isFinite(time) && time < now - EARLIER_MS;
  };
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  function visit(id: string) {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const hidden = expanded.has(id) ? [] : node.children.filter(child => old(child));
    const children = node.children.filter(child => !hidden.includes(child));
    const groupId = `earlier:${id}`;
    nodes.push({ ...node, children: hidden.length ? [...children, groupId] : children });
    children.forEach(visit);
    if (hidden.length) nodes.push({ id: groupId, kind: 'delegation', label: '', provider: '', model: '', role: 'earlier', state: 'idle', children: [], attempts: [], earlier: { parent: id, count: hidden.length } });
  }
  tree.roots.forEach(visit);
  const visible = new Set(nodes.map(node => node.id));
  const edges = tree.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
  for (const node of nodes) if (node.earlier) edges.push({ id: node.id, source: node.earlier.parent, target: node.id, title: '', kind: 'delegated', confidence: 'confirmed' });
  return { ...tree, nodes, edges };
}
function rank(node: GraphNode): number {
  const state = toDisplayState(node.state);
  return ['starting', 'running'].includes(state) ? 0 : state === 'waiting_approval' ? 1 : node.earlier ? 3 : 2;
}

/** 初回は列ごとに整列し、更新では残ったカードの位置を保持して末尾に足す。 */
export function calculateLayout(tree: GraphTree, viewportWidth: number, previous?: GraphLayout): GraphLayout {
  const vertical = viewportWidth < NARROW_WIDTH;
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const depths = new Map<string, number>();
  function visit(id: string, depth: number) {
    if (depths.has(id) || !byId.has(id)) return;
    depths.set(id, depth);
    byId.get(id)!.children.forEach(child => visit(child, depth + 1));
  }
  tree.roots.forEach(id => visit(id, 0));
  const layers = new Map<number, GraphNode[]>();
  for (const [id, depth] of depths) {
    if (!layers.has(depth)) layers.set(depth, []);
    layers.get(depth)!.push(byId.get(id)!);
  }
  const prior = new Map((previous?.vertical === vertical ? previous.nodes : []).map(node => [node.id, node]));
  const nodes: PositionedNode[] = [];
  let layerPosition = 0;
  for (const [depth, layer] of [...layers].sort(([a], [b]) => a - b)) {
    const ordered = layer.toSorted((a, b) => rank(a) - rank(b) || (b.activity ?? lastActivity(b)).localeCompare(a.activity ?? lastActivity(a)) || a.id.localeCompare(b.id));
    const sized = ordered.map(node => ({ id: node.id, depth, x: 0, y: 0, width: depth === 0 ? ROOT_WIDTH : CARD_WIDTH,
      height: node.earlier ? 88 : CARD_HEIGHT + (depth === 0 ? 20 : 0) + (node.approvalCount ? APPROVAL_HEIGHT - CARD_HEIGHT + (node.approvalCount - 1) * 106 : 0) }));
    const retained = sized.filter(node => prior.get(node.id)?.depth === depth).sort((a, b) => {
      const left = prior.get(a.id)!; const right = prior.get(b.id)!;
      return vertical ? left.x - right.x : left.y - right.y;
    });
    let end = 0;
    for (const node of [...retained, ...sized.filter(node => !retained.includes(node))]) {
      const saved = prior.get(node.id);
      const position = saved?.depth === depth ? Math.max(end, vertical ? saved.x : saved.y) : end;
      node.x = vertical ? position : layerPosition;
      node.y = vertical ? layerPosition : position;
      end = position + (vertical ? node.width : node.height) + ROW_GAP;
      nodes.push(node);
    }
    layerPosition += Math.max(...sized.map(node => vertical ? node.height : node.width)) + LAYER_GAP;
  }
  return { nodes, width: Math.max(0, ...nodes.map(node => node.x + node.width)), height: Math.max(0, ...nodes.map(node => node.y + node.height)), vertical };
}
export function curvePath(parent: PositionedNode, child: PositionedNode, vertical: boolean): string {
  const sx = parent.x + (vertical ? parent.width / 2 : parent.width);
  const sy = parent.y + (vertical ? parent.height : parent.height / 2);
  const tx = child.x + (vertical ? child.width / 2 : 0);
  const ty = child.y + (vertical ? 0 : child.height / 2);
  return vertical ? `M ${sx} ${sy} C ${sx} ${(sy + ty) / 2}, ${tx} ${(sy + ty) / 2}, ${tx} ${ty}`
    : `M ${sx} ${sy} C ${(sx + tx) / 2} ${sy}, ${(sx + tx) / 2} ${ty}, ${tx} ${ty}`;
}
