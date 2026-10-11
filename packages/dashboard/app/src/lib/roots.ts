import { resolveActivity } from './activity.ts';
import { useMemo } from 'react';
import type { Row, ScreenState } from './store.ts';
import { readObject, readText } from '../components/conversation/model.ts';
import { getRegisteredProjects, OTHER_PROJECT } from './projects.ts';
import { agentName, conversationName, conversationTitle, readModel, readTitle } from './format.ts';
import { readAttempts, type DelegationTree, type TreeNode } from '../pages/tree/model.ts';

export interface Root {
  id: string; name: string; project: string | null; state: string; last_activity_ts: string | null;
  current_conversation_id?: string;
  conversation_ids: string[]; running_children: number; total_children: number;
  /** キットが付けた番号の名前。画面ではプロジェクト名と始めた日の名前で呼び、番号は補足に出す。 */
  kit_name?: string;
  user_name?: string | null;
  auto_name?: string;
}
interface ConversationTimes { first?: number; last?: string }
function readConversationTimes(state: ScreenState): Map<string, ConversationTimes> {
  const messages = new Map((state.projection.messages ?? []).map(row => [row.id, row]));
  const spoken = new Map<string, Map<unknown, string>>();
  for (const link of state.projection.message_memberships ?? []) {
    if (link.active === 0 || link.active === false) continue;
    const ts = messages.get(link.message_id)?.source_ts;
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts))) continue;
    const id = String(link.conversation_id);
    if (!spoken.has(id)) spoken.set(id, new Map());
    spoken.get(id)!.set(link.message_id, ts);
  }
  const starts = new Map<string, number>();
  for (const run of state.projection.runs ?? []) {
    const time = Date.parse(String(run.started_ts ?? ''));
    if (!Number.isFinite(time)) continue;
    const id = String(run.conversation_id);
    starts.set(id, Math.min(starts.get(id) ?? time, time));
  }
  return new Map((state.projection.conversations ?? []).map(row => {
    const id = String(row.id);
    const times = [...(spoken.get(id)?.values() ?? [])].sort();
    // 最近の発言だけの窓を、系列の最初の発言と取り違えない。
    const complete = row.message_count === undefined || times.length >= Number(row.message_count);
    const firstMessage = Date.parse(String(row.first_message_ts ?? (complete ? times[0] : '') ?? ''));
    const created = Date.parse(String(row.created_ts ?? ''));
    const first = Number.isFinite(firstMessage) ? firstMessage : starts.get(id) ?? (Number.isFinite(created) ? created : undefined);
    const last = [row.last_message_ts, times.at(-1)].filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort().at(-1);
    return [id, { first, last }];
  }));
}
/** 発言の時刻を優先し、未配信なら実行の開始、観測の開始の順に使う。 */
export function startedAt(state: ScreenState, root: Root, times = readConversationTimes(state)): number | undefined {
  const starts = root.conversation_ids.map(id => times.get(id)?.first).filter((value): value is number => value !== undefined);
  return starts.length ? Math.min(...starts) : undefined;
}
/** キットの番号の名前を、プロジェクト名と始めた日の名前に置き換える。同じ日に複数あれば、始めた順に -2 から付ける。 */
function renameKitRoots(state: ScreenState, roots: Root[], times: Map<string, ConversationTimes>): Root[] {
  const groups = new Map<string, { root: Root; start: number }[]>();
  for (const root of roots) {
    const kit = /^(.+)-\d{3,}$/.exec(root.name);
    const start = kit ? startedAt(state, root, times) : undefined;
    if (!kit || start === undefined) continue;
    const day = new Date(start);
    const project = root.project ? String(state.projection.projects?.find(row => row.id === root.project)?.display_name ?? '') : '';
    const base = `${project || kit[1]}-${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`;
    groups.set(base, [...groups.get(base) ?? [], { root, start }]);
  }
  for (const [base, group] of groups) group.toSorted((a, b) => a.start - b.start || a.root.id.localeCompare(b.root.id))
    .forEach(({ root }, index) => { root.kit_name = root.name; root.name = index === 0 ? base : `${base}-${index + 1}`; });
  return roots;
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
/** レビュー役として別の会話を見ている会話。人が話す会話ではないので根の一覧に出さない。 */
export function reviewConversations(state: ScreenState): Set<string> {
  return new Set((state.projection.relations ?? []).filter(row => row.type === 'review_of' && row.active !== 0 && row.active !== false).map(row => String(row.from_id)));
}
/** 登録したプロジェクトに属さない根は、すべて Other の 1 つの区画に集める。 */
export function rootProject(root: { project: string | null }, registered: Set<string>): string {
  return root.project !== null && registered.has(root.project) ? root.project : OTHER_PROJECT;
}
export function selectRoots(state: ScreenState, project?: string): Root[] {
  const times = readConversationTimes(state);
  const reviews = reviewConversations(state);
  const registered = new Set(getRegisteredProjects(state).map(row => String(row.id)));
  return renameKitRoots(state, (state.projection.roots ?? []).filter(row => project === undefined || row.project === project
      || project === OTHER_PROJECT && rootProject(row as unknown as Root, registered) === OTHER_PROJECT)
    .filter(row => !((row.conversation_ids as string[] | undefined) ?? []).some(id => reviews.has(id)))
    .map(row => { const root = { ...(row as unknown as Root) }; root.conversation_ids ??= []; root.name = root.auto_name ?? root.name; root.name = rootName(state, root); const activity = resolveActivity(state, root.conversation_ids, root.state); root.state = activity.state;
      root.current_conversation_id ??= readText(activity.run?.conversation_id) || undefined;
      const spoken = root.conversation_ids.map(id => times.get(id)?.last).filter((value): value is string => Boolean(value));
      if (spoken.length) root.last_activity_ts = spoken.sort().at(-1)!;
      return root; }), times)
    .map(root => ({ ...root, auto_name: root.name, name: root.user_name || root.name }))
    .toSorted((a, b) => Number(isRunning(b.state) || ['waiting_approval', 'waiting_input'].includes(b.state)) - Number(isRunning(a.state) || ['waiting_approval', 'waiting_input'].includes(a.state))
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
    const requests = new Map((state.projection.delegations ?? []).map(row => [readText(row.request_id ?? row.id), row]));
    return { conversations, runs, runsById, children, delegations, requests };
  }, [state.projection.conversations, state.projection.runs, state.projection.relations, state.projection.delegations]);
}
export type RootIndex = ReturnType<typeof useRootIndex>;
/** 継続元も再開できるため、末尾でなく投影が選んだ操作先を使う。旧い配信では最新世代の状態と時刻で補う。 */
export function currentRootConversation(root: Root, index?: RootIndex): string | undefined {
  if (root.current_conversation_id && root.conversation_ids.includes(root.current_conversation_id)) return root.current_conversation_id;
  const rank = (id: string) => ['waiting_approval', 'waiting_input'].includes(readText(index?.runs.get(id)?.state)) ? 2
    : ['starting', 'running'].includes(readText(index?.runs.get(id)?.state)) ? 1 : 0;
  return [...root.conversation_ids].sort((a, b) => rank(b) - rank(a)
    || readText(index?.runs.get(b)?.last_evidence_ts ?? index?.conversations.get(b)?.last_message_ts ?? index?.conversations.get(b)?.created_ts)
      .localeCompare(readText(index?.runs.get(a)?.last_evidence_ts ?? index?.conversations.get(a)?.last_message_ts ?? index?.conversations.get(a)?.created_ts))
    || a.localeCompare(b))[0];
}
/** 会話の最後の動きの時刻。core の根の投影と同じく、最後の発言と最新の実行の時刻の遅い方を使う。 */
export function conversationActivity(state: ScreenState, id: string): string {
  const conversation = state.projection.conversations?.find(row => row.id === id);
  const run = (state.projection.runs ?? []).filter(row => row.conversation_id === id).toSorted((a, b) => Number(b.generation ?? 0) - Number(a.generation ?? 0))[0];
  return [conversation?.last_message_ts, run?.last_evidence_ts ?? run?.ended_ts ?? run?.started_ts]
    .filter((value): value is string => typeof value === 'string' && value !== '').sort().at(-1) ?? '';
}
/** 系列の会話を古い順に並べ、最新の会話を末尾に置く。時刻の分からない会話は元の順で先に置く。 */
export function orderSeries(state: ScreenState, ids: readonly string[]): string[] {
  const activity = new Map(ids.map(id => [id, conversationActivity(state, id)]));
  return ids.map((id, index) => ({ id, index })).toSorted((a, b) => activity.get(a.id)!.localeCompare(activity.get(b.id)!) || a.index - b.index).map(item => item.id);
}
export type ChildRole = 'orchestrate' | 'advisor' | 'research' | 'implement' | 'document' | 'review' | 'verify' | 'proofread';
/** 委譲の依頼を優先し、観測したエージェントの種別から同じ語彙へ写す。 */
export function resolveChildRole(evidence: Row = {}, delegation?: Row): ChildRole {
  const value = readText(readObject(delegation?.request).role ?? delegation?.role ?? evidence.agentType ?? evidence.role);
  switch (value) {
    case 'Explore': case 'claude-code-guide': case 'research': return 'research';
    case 'Plan': case 'plan': case 'advisor': return 'advisor';
    case 'orchestrate': return 'orchestrate';
    case 'verify': return 'verify';
    case 'proofread': return 'proofread';
    case 'general-purpose': {
      const title = readText(readObject(delegation?.request).title ?? delegation?.title ?? evidence.description ?? evidence.title);
      return /(?:\b(?:test|tests|testing|verify|verification|validate|validation|e2e|smoke)\b|検証|試験|テスト|実機|動作確認|本番.*確認)/i.test(title) ? 'verify' : 'implement';
    }
    case 'implement': case 'codex-exec': case 'work': return 'implement';
    case 'reviewer': case 'review': return 'review';
    case 'doc-light': case 'doc-heavy': case 'document': case 'write': return 'document';
    default: return 'implement';
  }
}
const ROLE_NAMES: Record<ChildRole, [string, string]> = {
  orchestrate: ['Main agent', 'メインエージェント'], advisor: ['Advisor', 'アドバイザー'], research: ['Research', 'リサーチ'], implement: ['Implementation', '実装'],
  document: ['Documentation', 'ドキュメント'], review: ['Code review', 'コードレビュー'], verify: ['Verification', '動作検証'], proofread: ['Proofreading', '校正'],
};
export function shownRole(role: string, language = typeof document !== 'undefined' ? document.documentElement.lang : 'en'): string {
  return ROLE_NAMES[role as ChildRole]?.[language === 'ja' ? 1 : 0] ?? (['general-purpose', 'subagent'].includes(role) ? '' : role);
}
/** 相手と役割の 1 行。「Claude Opus 5.5 · Work」の形にする。 */
export function nodeLine(node: TreeNode): string {
  return [agentName(node.provider, node.model) || 'Agent', shownRole(node.role)].filter(Boolean).join(' · ');
}
/** 依頼の題から、依頼のファイルの Markdown の見出しの印を外す。「# グラフを直す」は「グラフを直す」と出す。 */
export function requestTitle(title: string): string { return title.replace(/^\s*#{1,6}\s+/, '').trim(); }
export function buildRootTree(root: Root, index: RootIndex): DelegationTree {
  const nodes: TreeNode[] = [];
  const edges: DelegationTree['edges'] = [];
  const visited = new Set(root.conversation_ids);
  const current = currentRootConversation(root, index);
  const rootNode: TreeNode = { id: root.id, kind: 'conversation', conversationId: current, label: root.name,
    role: 'root', provider: readText(index.conversations.get(current ?? '')?.provider), model: '', state: root.state, children: [], attempts: [] };
  nodes.push(rootNode);
  function addChildren(parent: TreeNode, conversationId: string) {
    for (const relation of index.children.get(conversationId) ?? []) {
      const id = readText(relation.to_id);
      if (visited.has(id)) continue;
      visited.add(id);
      const conversation = index.conversations.get(id);
      const run = index.runs.get(id);
      const evidence = readObject(relation.evidence);
      const request = readText(evidence.request_id);
      const delegation = request ? index.requests.get(request) : undefined;
      const node: TreeNode = { id, kind: 'conversation', conversationId: id, run, label: '', attempts: [], children: [],
        provider: readText(conversation?.provider), model: readText(run?.model) || readModel(run).model || readText(conversation?.model) || readText(evidence.model),
        role: resolveChildRole(evidence, delegation), state: readText(run?.state ?? conversation?.state) || 'unknown' };
      // Claude の子は、結果を返して止まると待機に戻る。頼まれた仕事は終えているので、完了として見せる。
      if (node.provider === 'claude' && evidence.agentType !== undefined && node.state === 'idle') node.state = 'ended';
      node.label = nodeLine(node);
      nodes.push(node); parent.children.push(id);
      // 頼んだ内容は、子のエージェントの説明か、runner の委譲の題から取る。
      edges.push({ id: `relation:${readText(relation.id) || id}`, source: parent.id, target: id, title: requestTitle(readText(evidence.description) || readText(delegation?.title)),
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
      run, delegation, label: '', role: resolveChildRole({}, delegation), provider: readText(index.conversations.get(conversationId)?.provider ?? delegation.provider ?? assignment.executor),
      model: readText(run?.model) || readModel(run).model || readText(delegation.model) || readText(assignment.model), state: readText(run?.state ?? delegation.state) || 'unknown', children: [], attempts };
    node.delegation = delegation; node.attempts = [...attempts];
    if (run && !node.attempts.some(attempt => attempt.run_id === run.id)) node.attempts.push({ attempt: node.attempts.length + 1, run_id: run.id, state: run.state });
    node.model ||= readText(delegation.model ?? assignment.model); node.role = readObject(delegation.request).role || delegation.role ? resolveChildRole({}, delegation) : node.role;
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
