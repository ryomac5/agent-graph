import { useMemo } from 'react';
import type { Row, ScreenState } from './store.ts';
import { readObject, readText } from '../components/conversation/model.ts';
import { OTHER_PROJECT } from './projects.ts';
import { agentName, conversationName, conversationTitle, readModel, readTitle } from './format.ts';
import { readAttempts, type DelegationTree, type TreeNode } from '../pages/tree/model.ts';

export interface Root {
  id: string; name: string; project: string | null; state: string; last_activity_ts: string | null;
  conversation_ids: string[]; running_children: number; total_children: number;
}
export const isRunning = (state: string) => ['starting', 'running', 'assigned', 'verifying', 'reviewing'].includes(state);
/** 根の名前に内部の識別子が入っていれば、会話の名前の規則で呼び直す。 */
function rootName(state: ScreenState, root: Root): string {
  const name = readTitle(root.name);
  const internal = !name || /^\[\s*"/.test(name) || root.conversation_ids.includes(name) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name);
  if (!internal) return name;
  for (const id of root.conversation_ids) {
    const named = conversationName(state, id);
    if (named) return named;
  }
  let provider = '';
  try { const parsed: unknown = JSON.parse(name); if (Array.isArray(parsed)) provider = String(parsed[0] ?? ''); } catch { provider = ''; }
  return conversationTitle({ provider }, root.last_activity_ts ?? undefined);
}
export function selectRoots(state: ScreenState, project?: string): Root[] {
  return (state.projection.roots ?? []).filter(row => project === undefined || row.project === project || project === OTHER_PROJECT && row.project === null)
    .map(row => { const root = { ...(row as unknown as Root) }; root.conversation_ids ??= []; root.name = rootName(state, root); return root; }).toSorted((a, b) => Number(isRunning(b.state)) - Number(isRunning(a.state))
      || (b.last_activity_ts ?? '').localeCompare(a.last_activity_ts ?? '') || a.id.localeCompare(b.id));
}
export function useRootIndex(state: ScreenState) {
  return useMemo(() => {
    const conversations = new Map((state.projection.conversations ?? []).map(row => [readText(row.id), row]));
    const runs = new Map<string, Row>();
    for (const run of state.projection.runs ?? []) {
      const id = readText(run.conversation_id);
      if (!runs.has(id) || Number(run.generation ?? 0) >= Number(runs.get(id)?.generation ?? 0)) runs.set(id, run);
    }
    const runsById = new Map((state.projection.runs ?? []).map(row => [readText(row.id), row]));
    const children = new Map<string, Row[]>();
    for (const relation of state.projection.relations ?? []) {
      if (relation.type !== 'delegated' || relation.active === 0 || relation.active === false) continue;
      const parent = readText(relation.from_id);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(relation);
    }
    const delegations = new Map<string, Row[]>();
    for (const delegation of state.projection.delegations ?? []) {
      const root = readText(delegation.root_id);
      if (!delegations.has(root)) delegations.set(root, []);
      delegations.get(root)!.push(delegation);
    }
    return { conversations, runs, runsById, children, delegations };
  }, [state.projection.conversations, state.projection.runs, state.projection.relations, state.projection.delegations]);
}
export type RootIndex = ReturnType<typeof useRootIndex>;
/** 相手と役割の 1 行。「Claude Opus 5.5 · general-purpose」の形にする。 */
export function nodeLine(node: TreeNode): string {
  return [agentName(node.provider, node.model) || 'Agent', node.role].filter(Boolean).join(' · ');
}
export function buildRootTree(root: Root, index: RootIndex): DelegationTree {
  const nodes: TreeNode[] = [];
  const edges: DelegationTree['edges'] = [];
  const visited = new Set(root.conversation_ids);
  const rootNode: TreeNode = { id: root.id, kind: 'conversation', conversationId: root.conversation_ids.at(-1), label: root.name,
    role: 'root', provider: '', model: '', state: root.state, children: [], attempts: [] };
  nodes.push(rootNode);
  function addChildren(parent: TreeNode, conversationId: string) {
    for (const relation of index.children.get(conversationId) ?? []) {
      const id = readText(relation.to_id);
      if (visited.has(id)) continue;
      visited.add(id);
      const conversation = index.conversations.get(id);
      const run = index.runs.get(id);
      const evidence = readObject(relation.evidence);
      const node: TreeNode = { id, kind: 'conversation', conversationId: id, run, label: '', attempts: [], children: [],
        provider: readText(conversation?.provider), model: readModel(run).model || readText(run?.model ?? conversation?.model ?? evidence.model),
        role: readText(evidence.agentType ?? evidence.role) || 'subagent', state: readText(run?.state ?? conversation?.state) || 'unknown' };
      node.label = nodeLine(node);
      nodes.push(node); parent.children.push(id);
      edges.push({ id: `relation:${readText(relation.id) || id}`, source: parent.id, target: id, title: readText(evidence.description),
        confidence: readText(relation.confidence) || 'confirmed', kind: 'delegated' });
      addChildren(node, id);
    }
  }
  for (const id of root.conversation_ids) addChildren(rootNode, id);
  const groups = new Map<string, TreeNode>();
  for (const delegation of index.delegations.get(root.id) ?? []) {
    const attempts = readAttempts(delegation);
    const attempt = attempts.at(-1);
    const recordedRun = index.runsById.get(readText(attempt?.run_id ?? delegation.run_id));
    const run = index.runs.get(readText(recordedRun?.conversation_id)) ?? recordedRun;
    const conversationId = readText(run?.conversation_id ?? delegation.conversation_id);
    const kit = readObject(readObject(delegation.payload).kit ?? delegation.kit);
    const origin = readObject(delegation.origin);
    const assignment = readObject(attempt?.assignment);
    const graphName = readText(delegation.graph_name ?? delegation.graph_id ?? kit.graph ?? kit.session ?? origin.session) || 'Planner graph';
    const planner = Boolean(delegation.graph_id || delegation.graph_name || Object.keys(kit).length || origin.source === 'planner' || delegation.source === 'planner');
    let group = planner ? groups.get(graphName) : rootNode;
    if (!group) {
      group = { id: `graph:${graphName}`, kind: 'delegation', label: graphName, role: 'planner', provider: '', model: '', state: '', children: [], attempts: [] };
      groups.set(graphName, group); nodes.push(group); rootNode.children.push(group.id);
      edges.push({ id: group.id, source: root.id, target: group.id, title: '', confidence: 'confirmed', kind: 'delegated' });
    }
    const existing = nodes.find(node => node.conversationId === conversationId && conversationId);
    const node: TreeNode = existing ?? { id: `delegation:${readText(delegation.id)}`, kind: 'delegation', conversationId: conversationId || undefined,
      run, delegation, label: '', role: readText(delegation.role) || 'task', provider: readText(index.conversations.get(conversationId)?.provider ?? delegation.provider ?? assignment.executor),
      model: readModel(run).model || readText(delegation.model ?? assignment.model), state: readText(run?.state ?? delegation.state) || 'unknown', children: [], attempts };
    node.delegation = delegation; node.attempts = [...attempts];
    if (run && !node.attempts.some(attempt => attempt.run_id === run.id)) node.attempts.push({ attempt: node.attempts.length + 1, run_id: run.id, state: run.state });
    node.model ||= readText(delegation.model ?? assignment.model); node.role = readText(delegation.role) || node.role;
    node.label = nodeLine(node);
    for (const attempt of attempts) {
      const priorConversation = readText(index.runsById.get(readText(attempt.run_id))?.conversation_id);
      const prior = nodes.find(item => item !== node && item.conversationId === priorConversation && priorConversation);
      if (!prior) continue;
      node.children.push(...prior.children.filter(id => id !== node.id && !node.children.includes(id)));
      for (const parent of nodes) parent.children = parent.children.filter(id => id !== prior.id);
      for (const edge of edges) if (edge.source === prior.id) edge.source = node.id;
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].target === prior.id) edges.splice(i, 1);
      nodes.splice(nodes.indexOf(prior), 1);
    }
    if (existing && !planner) {
      const edge = edges.find(edge => edge.target === node.id);
      if (edge) edge.title ||= readText(delegation.title ?? delegation.description);
      continue;
    }
    if (existing) {
      for (const parent of nodes) parent.children = parent.children.filter(id => id !== node.id);
      const edgeIndex = edges.findIndex(edge => edge.target === node.id);
      if (edgeIndex >= 0) edges.splice(edgeIndex, 1);
    } else nodes.push(node);
    group.children.push(node.id);
    edges.push({ id: `task:${readText(delegation.id)}`, source: group.id, target: node.id,
      title: readText(delegation.title ?? delegation.description), confidence: 'confirmed', kind: 'delegated' });
    if (!existing && conversationId) addChildren(node, conversationId);
  }
  return { nodes, edges, roots: [root.id], unresolved: [] };
}
