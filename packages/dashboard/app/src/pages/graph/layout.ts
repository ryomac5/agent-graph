import type { DelegationTree, TreeNode } from '../tree/model.ts';
import { lastActivity } from '../../components/RootViews.tsx';
import { toDisplayState } from '../../components/StateBadge.tsx';

export const NARROW_WIDTH = 720;
const EARLIER_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 4;
const COLUMN_ROWS = 8;
const CARD_WIDTH = 240;
const CARD_HEIGHT = 76;
const TITLE_LINE_HEIGHT = 20;
const TITLE_WIDTH = CARD_WIDTH - 58;
const APPROVAL_HEIGHT = 106;
const LAYER_GAP = 80;
const ROW_GAP = 16;
export interface GraphNode extends TreeNode { activity?: string; approvalCount?: number; earlier?: { parent: string; count: number; kind: 'earlier' | 'completed'; expanded: boolean } }
export interface GraphTree extends Omit<DelegationTree, 'nodes'> { nodes: GraphNode[] }
export interface PositionedNode { id: string; depth: number; x: number; y: number; width: number; height: number; route?: { y: number; lane: number } }
export interface GraphLayout { nodes: PositionedNode[]; width: number; height: number; vertical: boolean }

/** 注意が必要な枝を残し、完了した枝だけを親ごとに畳む。 */
export function foldEarlier(tree: GraphTree, expanded: ReadonlySet<string>, now: number, selected?: string): GraphTree {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const complete = (id: string, ancestors = new Set<string>()): boolean => {
    const node = byId.get(id);
    if (!node || id === selected || ancestors.has(id) || node.approvalCount) return false;
    if (!node.children.every(child => complete(child, new Set([...ancestors, id])))) return false;
    if (node.role === 'planner' && !node.conversationId) return node.children.length > 0;
    return ['ended', 'idle'].includes(toDisplayState(node.state));
  };
  const endedAt = (id: string) => {
    const node = byId.get(id)!;
    return Date.parse(String(node.run?.ended_ts || node.activity || lastActivity(node)));
  };
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  function visit(id: string) {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const finished = node.children.filter(child => complete(child));
    const old = (child: string): boolean => complete(child) && endedAt(child) < now - EARLIER_MS && byId.get(child)!.children.every(old);
    const earlier = finished.filter(old);
    const recent = finished.filter(child => !earlier.includes(child) && Number.isFinite(endedAt(child))).sort((a, b) => endedAt(b) - endedAt(a) || a.localeCompare(b));
    const undated = finished.filter(child => !Number.isFinite(endedAt(child)));
    const groups = [{ kind: 'completed' as const, children: [...recent.slice(RECENT_LIMIT), ...undated] }, { kind: 'earlier' as const, children: earlier }]
      .filter(group => group.children.length).map(group => ({ ...group, id: `${group.kind}:${id}`, expanded: expanded.has(`${group.kind}:${id}`) }));
    const hidden = new Set(groups.filter(group => !group.expanded).flatMap(group => group.children));
    const children = node.children.filter(child => !hidden.has(child));
    nodes.push({ ...node, children: [...children, ...groups.map(group => group.id)] });
    children.forEach(visit);
    for (const group of groups) nodes.push({ id: group.id, kind: 'delegation', label: '', provider: '', model: '', role: group.kind, state: 'idle', children: [], attempts: [],
      earlier: { parent: id, count: group.children.length, kind: group.kind, expanded: group.expanded } });
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
function orderNodes(nodes: GraphNode[]) {
  return nodes.toSorted((a, b) => rank(a) - rank(b) || (b.activity ?? lastActivity(b)).localeCompare(a.activity ?? lastActivity(a)) || a.id.localeCompare(b.id));
}

/** 狭い画面は木の順、広い画面は八行で折り返す。 */
export function calculateLayout(tree: GraphTree, viewportWidth: number, previous?: GraphLayout, titleHeights?: ReadonlyMap<string, number>): GraphLayout {
  const vertical = viewportWidth < NARROW_WIDTH;
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const depths = new Map<string, number>();
  function visit(id: string, depth: number) {
    if (depths.has(id) || !byId.has(id)) return;
    depths.set(id, depth);
    orderNodes(byId.get(id)!.children.map(child => byId.get(child)!).filter(Boolean)).forEach(child => visit(child.id, depth + 1));
  }
  tree.roots.forEach(id => visit(id, 0));
  const sizeNode = (node: GraphNode, depth: number): PositionedNode => {
    const titleWidth = [...node.label].reduce((width, letter) => width + (/[^\x00-\xff]/.test(letter) ? 13 : 6.5), 0);
    const titleHeight = titleHeights?.get(node.label) ?? (titleWidth > TITLE_WIDTH ? TITLE_LINE_HEIGHT * 2 : TITLE_LINE_HEIGHT);
    return { id: node.id, depth, x: 0, y: 0, width: CARD_WIDTH,
      height: CARD_HEIGHT + (node.earlier ? 0 : Math.max(0, titleHeight - TITLE_LINE_HEIGHT)) + (node.approvalCount ?? 0) * APPROVAL_HEIGHT };
  };
  const nodes: PositionedNode[] = [];
  if (vertical) {
    let y = 0;
    for (const [id, depth] of depths) {
      const node = sizeNode(byId.get(id)!, depth);
      node.x = Math.min(depth * 16, viewportWidth / 3); node.y = y;
      node.width = Math.max(1, viewportWidth - 32 - node.x); y += node.height + ROW_GAP;
      nodes.push(node);
    }
  } else {
    const layers = new Map<number, GraphNode[]>();
    for (const [id, depth] of depths) layers.set(depth, [...(layers.get(depth) ?? []), byId.get(id)!]);
    const prior = new Map((previous?.vertical === vertical ? previous.nodes : []).map((node, index) => [node.id, index]));
    let x = 0;
    for (const [depth, layer] of layers) {
      const ordered = orderNodes(layer);
      const retained = ordered.filter(node => prior.has(node.id)).sort((a, b) => prior.get(a.id)! - prior.get(b.id)!);
      const sized = [...retained, ...ordered.filter(node => !prior.has(node.id))].map(node => sizeNode(node, depth));
      const columns = Math.ceil(sized.length / COLUMN_ROWS);
      for (let column = 0; column < columns; column++) {
        let y = 0;
        for (const [row, node] of sized.slice(column * COLUMN_ROWS, (column + 1) * COLUMN_ROWS).entries()) {
          node.x = x + column * (CARD_WIDTH + LAYER_GAP); node.y = y;
          if (column > 0) node.route = { y: -16 - (column * COLUMN_ROWS + row) * 2, lane: row };
          y += node.height + ROW_GAP; nodes.push(node);
        }
      }
      x += columns * (CARD_WIDTH + LAYER_GAP);
    }
  }
  return { nodes, width: Math.max(0, ...nodes.map(node => node.x + node.width)), height: Math.max(0, ...nodes.map(node => node.y + node.height)), vertical };
}
export function curvePath(parent: PositionedNode, child: PositionedNode, vertical: boolean): string {
  const sx = parent.x + (vertical ? parent.width / 2 : parent.width);
  const sy = parent.y + (vertical ? parent.height : parent.height / 2);
  const tx = child.x + (vertical ? child.width / 2 : 0);
  const ty = child.y + (vertical ? 0 : child.height / 2);
  if (!vertical && child.route) {
    const { y, lane } = child.route;
    const exit = sx + 16 + lane * 2;
    const entry = tx - 16 - lane * 2;
    return `M ${sx} ${sy} L ${exit} ${sy} L ${exit} ${y} L ${entry} ${y} L ${entry} ${ty} L ${tx} ${ty}`;
  }
  return vertical ? `M ${sx} ${sy} C ${sx} ${(sy + ty) / 2}, ${tx} ${(sy + ty) / 2}, ${tx} ${ty}`
    : `M ${sx} ${sy} C ${(sx + tx) / 2} ${sy}, ${(sx + tx) / 2} ${ty}, ${tx} ${ty}`;
}
