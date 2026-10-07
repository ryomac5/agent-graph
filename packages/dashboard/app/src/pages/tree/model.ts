import { decodeStoredValue, readObject, readText } from '../../components/activity.ts';
import type { ExecutionState } from '../../components/StateBadge.tsx';
import { conversationName, readModel, runLabel } from '../../lib/format.ts';
import { createProjectMatcher } from '../../lib/projects.ts';
import type { Row, ScreenState } from '../../lib/store.ts';

export interface TreeNode {
  id: string; kind: 'conversation' | 'run' | 'delegation'; label: string;
  conversationId?: string; run?: Row; delegation?: Row; attempts: Row[];
  role: string; provider: string; model: string; state: string; cost?: number; children: string[];
}
const EXECUTION_STATES = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'ended', 'failed', 'unknown']);
/** 委譲の状態を、実行の状態の語彙に寄せる。印と色は実行と同じ規則で出す。 */
export function toExecutionState(state: string): ExecutionState {
  if (EXECUTION_STATES.has(state)) return state as ExecutionState;
  if (['assigned', 'verifying', 'reviewing'].includes(state)) return 'running';
  if (['received', 'accepted'].includes(state)) return 'starting';
  if (state === 'done' || state === 'interrupted') return 'ended';
  if (state === 'denied') return 'failed';
  return 'unknown';
}
export const ACTIVE_EXECUTION_STATES: readonly string[] = ['starting', 'running', 'waiting_approval', 'waiting_input'];
export interface TreeEdge {
  id: string; source: string; target: string; title: string;
  confidence: string; kind: 'delegated' | 'dependency' | 'candidate';
}
export interface DelegationTree { nodes: TreeNode[]; roots: string[]; unresolved: string[]; edges: TreeEdge[] }
export function readAttempts(delegation: Row): Row[] {
  const attempts = decodeStoredValue(delegation.attempts);
  return (Array.isArray(attempts) ? attempts.map(readObject) : [])
    .sort((a, b) => Number(a.attempt) - Number(b.attempt));
}

// 親子の確定と候補の辺は分離し、依存の辺は木に混ぜない。
export function buildDelegationTree(state: ScreenState, project?: string): DelegationTree {
  const p = state.projection;
  const conversations = p.conversations ?? [];
  const runs = p.runs ?? [];
  const nodes = new Map<string, TreeNode>();
  const edges: TreeEdge[] = [];
  const parents = new Map<string, string>();
  const unresolved = new Set<string>();
  const runId = (id: string) => state.identities?.runs[id] ?? id;
  const conversationId = (id: string) => state.identities?.conversations[id] ?? id;
  const conversationsById = new Map(conversations.map(row => [readText(row.id), row]));
  const latestRuns = new Map<string, Row>();
  for (const run of runs) {
    const id = readText(run.conversation_id);
    const latest = latestRuns.get(id);
    if (!latest || Number(run.generation ?? 0) > Number(latest.generation ?? 0)) latestRuns.set(id, run);
  }
  for (const c of conversations) {
    const id = readText(c.id);
    const latest = latestRuns.get(id);
    nodes.set(`conversation:${id}`, { id: `conversation:${id}`, kind: 'conversation',
      label: conversationName(state, id) || 'Untitled conversation', conversationId: id,
      // 根は作業である。外の端末から起こした作業は、その会話を根にする。
      role: readText(c.task_id) ? 'Task' : c.origin === 'observed' ? 'Terminal conversation' : 'Conversation', provider: readText(c.provider), model: readText(c.model) || readModel(latest).model || readText(latest?.model),
      state: readText(latest?.state) || 'unknown', attempts: [], children: [] });
  }
  for (const run of runs) {
    const id = `run:${readText(run.id)}`;
    nodes.set(id, { id, kind: 'run', label: runLabel(state, run.id), run,
      conversationId: readText(run.conversation_id), role: 'Execution',
      provider: readText(conversationsById.get(readText(run.conversation_id))?.provider), model: readModel(run).model || readText(run.model),
      state: readText(run.state) || 'unknown', attempts: [], children: [],
      cost: typeof run.cost === 'number' ? run.cost : undefined });
  }
  const attach = (source: string, target: string, edge: TreeEdge) => {
    if (!nodes.has(source) || !nodes.has(target) || source === target) return false;
    let ancestor: string | undefined = source;
    const visited = new Set<string>();
    while (ancestor && !visited.has(ancestor)) {
      if (ancestor === target) return false;
      visited.add(ancestor); ancestor = parents.get(ancestor);
    }
    if (parents.has(target) && parents.get(target) !== source) return false;
    parents.set(target, source);
    edges.push(edge);
    return true;
  };
  const delegationNodes = new Map<string, string>();
  const runNodes = new Map<string, string>();
  const conversationNodes = new Map<string, string>();
  const runsById = new Map(runs.map(run => [readText(run.id), run]));
  const conversationRuns = new Map<string, Row[]>();
  for (const run of runs) {
    const id = readText(run.conversation_id);
    const history = conversationRuns.get(id) ?? [];
    history.push(run);
    conversationRuns.set(id, history);
  }
  for (const history of conversationRuns.values()) {
    history.sort((a, b) => Number(a.generation) - Number(b.generation) || readText(a.id).localeCompare(readText(b.id)));
  }
  for (const d of p.delegations ?? []) {
    const recorded = readAttempts(d);
    const recordedRuns = new Map(recorded.filter(attempt => attempt.run_id)
      .map(attempt => [runId(readText(attempt.run_id)), attempt]));
    const attempts: Row[] = [];
    const seen = new Set<string>();
    // 委譲は会話に結ばれる。再開の世代も、受付の再試行も同じ節の履歴に収める。
    for (const attempt of recorded) {
      const original = runsById.get(runId(readText(attempt.run_id)));
      const history = original ? (conversationRuns.get(readText(original.conversation_id)) ?? [])
        .filter(run => Number(run.generation) >= Number(original.generation)) : [];
      for (const run of history.length ? history : [undefined]) {
        const key = run ? readText(run.id) : runId(readText(attempt.run_id));
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        const saved = recordedRuns.get(key);
        attempts.push({ ...(saved ?? (run ? { assignment: attempt.assignment } : attempt)), attempt: attempts.length + 1,
          ...(run ? { run_id: run.id, state: saved?.state ?? run.state } : {}) });
      }
    }
    const latest = attempts.at(-1);
    const id = latest?.run_id ? `run:${runId(readText(latest.run_id))}` : `delegation:${readText(d.id)}`;
    const existing = nodes.get(id);
    const assignment = readObject(latest?.assignment);
    const resumed = latest && !recordedRuns.has(runId(readText(latest.run_id)));
    const node: TreeNode = { id, kind: existing?.kind ?? 'delegation', label: readText(d.title) || existing?.label || 'Untitled delegation',
      run: existing?.run, conversationId: existing?.conversationId, delegation: d, attempts,
      role: readText(d.role) || 'Delegation',
      provider: readText(assignment.executor) || readText(assignment.provider) || readText(d.provider) || existing?.provider || '',
      model: resumed ? readModel(existing?.run ?? {}).model || readText(assignment.model) || readText(d.model)
        : readText(assignment.model) || readText(d.model) || existing?.model || '',
      state: resumed ? existing?.state || 'unknown' : readText(d.state) || existing?.state || 'unknown', cost: existing?.cost, children: [] };
    for (const attempt of attempts) {
      const key = runId(readText(attempt.run_id));
      const run = runsById.get(key);
      if (key) runNodes.set(key, id);
      if (run) conversationNodes.set(readText(run.conversation_id), id);
      nodes.delete(`run:${key}`);
    }
    nodes.set(id, node);
    delegationNodes.set(readText(d.request_id ?? d.id), id);
  }
  const endpoint = (value: unknown, child = false): string | undefined => {
    const raw = readText(value);
    const delegated = runNodes.get(runId(raw)) ?? conversationNodes.get(conversationId(raw));
    if (delegated) return delegated;
    const direct = `run:${runId(raw)}`;
    if (nodes.has(direct)) return direct;
    const c = conversationId(raw);
    const latest = latestRuns.get(c);
    const conversation = conversationsById.get(c);
    if (latest && (child || conversation?.origin === 'managed')) return `run:${readText(latest.id)}`;
    return nodes.has(`conversation:${c}`) ? `conversation:${c}` : undefined;
  };
  for (const relation of p.relations ?? []) {
    if (relation.active === false || relation.active === 0 || !['delegated', 'review_of', 'depends_on', 'dependency'].includes(readText(relation.type))) continue;
    if (relation.type === 'review_of') {
      const source = endpoint(relation.to_id);
      const target = endpoint(relation.from_id, true);
      if (source && target) {
        const parent = nodes.get(source)!;
        const child = nodes.get(target)!;
        child.label = `Review of ${conversationName(state, parent.conversationId ?? '') || parent.label}`;
        child.role = 'Reviewer';
        const edge: TreeEdge = { id: `relation:${readText(relation.id)}`, source, target, title: 'Review',
          confidence: readText(relation.confidence), kind: relation.confidence === 'confirmed' ? 'delegated' : 'candidate' };
        if (relation.confidence === 'confirmed') attach(source, target, edge);
        else { unresolved.add(target); edges.push(edge); }
      }
      continue;
    }
    const evidence = readObject(relation.evidence);
    const dNode = delegationNodes.get(readText(evidence.request_id));
    const d = dNode ? nodes.get(dNode)?.delegation : undefined;
    const attempt = d && readAttempts(d).find(a => Number(a.attempt) === Number(evidence.attempt));
    const relationTarget = endpoint(relation.to_id, true);
    const attemptTarget = attempt?.run_id ? endpoint(runId(readText(attempt.run_id)), true) : dNode;
    const attemptConversation = attemptTarget ? nodes.get(attemptTarget)?.conversationId : undefined;
    const target = relationTarget && nodes.get(relationTarget)?.conversationId !== attemptConversation
      ? relationTarget : attemptTarget ?? relationTarget;
    const parentRun = endpoint(evidence.parent_run_id ?? d?.parent_run_id);
    const relationSource = endpoint(relation.from_id);
    // 訂正された関係を優先し、同じ会話のときだけ実行の正確な世代を使う。
    const source = parentRun && (!relationSource || nodes.get(parentRun)?.conversationId === nodes.get(relationSource)?.conversationId)
      ? parentRun : relationSource;
    if (!target) continue;
    const confidence = readText(relation.confidence) || 'unknown';
    const dependency = relation.type !== 'delegated';
    const edge: TreeEdge = { id: `relation:${readText(relation.id)}`, source: source ?? '', target,
      title: readText(d?.title ?? relation.title) || (dependency ? 'Dependency' : 'Delegation'), confidence,
      kind: dependency ? 'dependency' : confidence === 'confirmed' ? 'delegated' : 'candidate' };
    if (dependency) { if (source) edges.push(edge); continue; }
    if (confidence === 'confirmed' && source && attach(source, target, edge)) continue;
    unresolved.add(target);
    if (source) edges.push({ ...edge, kind: 'candidate' });
  }
  for (const [requestId, id] of delegationNodes) {
    if (parents.has(id) || unresolved.has(id)) continue;
    const d = nodes.get(id)!.delegation!;
    const parent = readObject(d.parent);
    const origin = readObject(d.origin);
    const observed = conversations.filter(c => c.provider === origin.provider && c.native_id === origin.native_id);
    const source = endpoint(parent.run_id ?? d.parent_run_id ?? parent.conversation_id
      ?? (observed.length === 1 ? observed[0]!.id : undefined));
    if (parent.confidence === 'confirmed' && source && attach(source, id, {
      id: `parent:${requestId}`, source, target: id, title: readText(d.title) || 'Delegation', confidence: 'confirmed', kind: 'delegated',
    })) continue;
    unresolved.add(id);
    if (source) edges.push({ id: `candidate:${requestId}`, source, target: id,
      title: readText(d.title) || 'Delegation', confidence: 'unknown', kind: 'candidate' });
  }
  // 起動元の会話を根にし、各世代の実行はその下に保持する。
  for (const node of nodes.values()) {
    if (node.kind !== 'run' || parents.has(node.id) || unresolved.has(node.id)) continue;
    const source = `conversation:${node.conversationId}`;
    attach(source, node.id, { id: `execution:${node.id}`, source, target: node.id,
      title: 'Execution', confidence: 'confirmed', kind: 'delegated' });
  }
  for (const [child, parent] of parents) { nodes.get(parent)!.children.push(child); unresolved.delete(child); }
  for (const node of nodes.values()) {
    if (node.kind === 'conversation' && node.children.length === 0 && latestRuns.has(node.conversationId ?? '')) nodes.delete(node.id);
  }
  let visible = new Set(nodes.keys());
  if (project) {
    // 経路のプロジェクトは表示名でも識別子でも受け、作業と会話と委譲と実行のどれかが結ぶプロジェクトで絞る。
    const matches = createProjectMatcher(state, project);
    const tasks = new Map((p.tasks ?? []).map(row => [readText(row.id), row]));
    visible = new Set([...nodes.values()].filter(n => {
      const c = conversationsById.get(n.conversationId ?? '');
      return matches([c?.project, tasks.get(readText(c?.task_id))?.project, c?.repository_id, n.delegation?.project, n.delegation?.repository_id,
        n.delegation?.cwd, n.run?.repository_id, n.run?.cwd]);
    }).map(n => n.id));
    for (const node of nodes.values()) {
      if (node.role === 'Reviewer' && visible.has(parents.get(node.id) ?? '')) visible.add(node.id);
    }
    for (const id of [...visible]) {
      let parent = parents.get(id);
      while (parent) { visible.add(parent); parent = parents.get(parent); }
    }
  }
  // 木の根は作業である。名前のある作業と管理する会話と、委譲を起こした会話だけを根にし、委譲のない外の会話は木に出さない。
  const isWork = (node: TreeNode): boolean => {
    const c = conversationsById.get(node.conversationId ?? '');
    return Boolean(readText(c?.task_id)) || c?.origin === 'managed' || Boolean(node.delegation);
  };
  const delegates = (id: string, root: string | undefined, seen = new Set<string>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    return (nodes.get(id)?.children ?? []).some(child => {
      const node = nodes.get(child);
      return Boolean(node && (node.delegation || node.conversationId !== root)) || delegates(child, root, seen);
    });
  };
  for (const node of [...nodes.values()]) {
    if (parents.has(node.id) || unresolved.has(node.id) || isWork(node) || delegates(node.id, node.conversationId)) continue;
    const drop = [node.id];
    for (let index = 0; index < drop.length; index++) drop.push(...(nodes.get(drop[index])?.children ?? []));
    for (const id of drop) visible.delete(id);
  }
  const ordered = [...nodes.values()].filter(n => visible.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const node of ordered) node.children = node.children.filter(id => visible.has(id)).sort();
  return { nodes: ordered, edges: edges.filter(e => visible.has(e.source) && visible.has(e.target)),
    roots: ordered.filter(n => !parents.has(n.id) && !unresolved.has(n.id)).map(n => n.id),
    unresolved: [...unresolved].filter(id => visible.has(id)).sort() };
}
