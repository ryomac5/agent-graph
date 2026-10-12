import type { DelegationTree, TreeNode } from '../tree/model.ts';
import { toDisplayState } from '../../components/StateBadge.tsx';
import { decodeStoredValue, readBody, readObject, readText } from '../../components/conversation/model.ts';
import { isCompletedGraph, resolveChildRole, type ChildRole } from '../../lib/roots.ts';
import type { Row, ScreenState } from '../../lib/store.ts';
import type { Language } from '../../lib/i18n.ts';
import type { IconName } from '../../components/Icon.tsx';

export const RECENT_MS = 2 * 60 * 60 * 1000;
export const FAILURE_MS = 24 * 60 * 60 * 1000;
export const RECENT_LIMIT = 5;
export const PAGE_SIZE = 20;
export const GRAPH_COMPACT_WIDTH = 560;
export const COMPACT_ROW_EXTRA = 16;
export const GRAPH_ROW_HEIGHT = 32;
export const RUNNING_ROW_HEIGHT = 52;
export const APPROVAL_ROW_HEIGHT = 28;
export type GraphRole = ChildRole | 'main' | 'planner';
export const ROLES: ChildRole[] = ['orchestrate', 'advisor', 'research', 'implement', 'document', 'review', 'verify', 'proofread'];
export const ROLE_ICONS: Record<GraphRole, IconName> = { main: 'message', planner: 'plan', orchestrate: 'message', advisor: 'plan', research: 'search', implement: 'tool', document: 'file', review: 'check', verify: 'check', proofread: 'file' };
const ROLE_WORDS: Record<GraphRole, [string, string]> = { main: ['Main agent', 'メインエージェント'], planner: ['Task graph', 'タスクグラフ'], orchestrate: ['Main agent', 'メインエージェント'], advisor: ['Advisor', 'アドバイザー'], research: ['Research', 'リサーチ'], implement: ['Implementation', '実装'], document: ['Documentation', 'ドキュメント'], review: ['Code review', 'コードレビュー'], verify: ['Verification', '動作検証'], proofread: ['Proofreading', '校正'] };
export function roleWord(role: GraphRole, language: Language) { return ROLE_WORDS[role][language === 'ja' ? 1 : 0]; }
export interface GraphNode extends TreeNode { activity?: string; currentWork?: string; report?: string; approvals?: Row[]; inferred?: boolean }
export interface GraphTree extends Omit<DelegationTree, 'nodes'> { nodes: GraphNode[] }
export interface TimeSegment { start: number; end: number; state: string }
export interface GraphRow {
  id: string; parent?: string; depth: number; ancestors: string[]; node?: GraphNode; role?: GraphRole;
  runningBelow: number; runningPath: boolean; selectedPath: boolean; height: number; segments: TimeSegment[];
  group?: { kind: 'today' | 'earlier'; count: number; shown: number; roles: Partial<Record<ChildRole, number>>; members: string[]; more?: boolean; groupId?: string };
}
export interface GraphRows { rows: GraphRow[]; all: GraphRow[]; running: number; needsYou: number; roles: Partial<Record<ChildRole, number>> }
export function readGraphActivity(node: GraphNode): string {
  const fields = ['updated_ts', 'completed_ts', 'ended_ts', 'last_evidence_ts', 'started_ts', 'created_ts', 'ts'];
  return [node.activity, ...[node.run, node.delegation, ...node.attempts].flatMap(row => fields.map(field => row?.[field]))]
    .filter((time): time is string => typeof time === 'string' && Number.isFinite(Date.parse(time)))
    .toSorted((a, b) => Date.parse(b) - Date.parse(a))[0] ?? '';
}
export function readSegments(node: GraphNode, now: number, state?: ScreenState): TimeSegment[] {
  const records = node.attempts.map(attempt => ({ ...attempt, ...state?.projection.runs?.find(run => run.id === attempt.run_id) }));
  if (node.run && !records.some(record => record.run_id === node.run?.id)) records.push(node.run);
  if (!records.length && node.delegation) records.push(node.delegation);
  return records.flatMap(record => {
    const start = Date.parse(readText(record.started_ts ?? record.created_ts));
    const active = ['starting', 'running'].includes(toDisplayState(readText(record.state) || node.state));
    const end = active ? now : Date.parse(readText(record.ended_ts ?? record.completed_ts ?? record.updated_ts ?? node.activity));
    return Number.isFinite(start) && Number.isFinite(end) ? [{ start, end: Math.max(start, end), state: readText(record.state) || node.state }] : [];
  });
}
/** 最後の道具の対象だけを取り、本文や出力を作業の語に混ぜない。 */
export function readCurrentWork(state: ScreenState, conversationId: string, language: Language): string {
  const ids = new Set((state.projection.message_memberships ?? []).filter(row => row.conversation_id === conversationId && row.active !== 0 && row.active !== false).map(row => row.message_id));
  const messages = (state.projection.messages ?? []).filter(row => ids.has(row.id)).toSorted((a, b) => readText(a.source_ts).localeCompare(readText(b.source_ts)));
  for (const message of messages.toReversed()) {
    const body = decodeStoredValue(message.body);
    const call = (Array.isArray(body) ? body : []).map(readObject).findLast(block => block.type === 'tool_use');
    if (!call) continue;
    const input = readObject(call.input ?? call.arguments);
    const name = readText(call.name);
    const path = readText(input.file_path ?? input.path ?? input.filename).split('/').at(-1) ?? '';
    const raw = typeof (call.input ?? call.arguments) === 'string' ? String(call.input ?? call.arguments) : readText(input.patch);
    const patched = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(raw)?.[1].split('/').at(-1) ?? '';
    const target = path || patched || readText(input.pattern ?? input.query ?? input.command ?? input.cmd).split('\n')[0];
    const verb = /edit|write|patch/i.test(name) ? ['Editing', 'を編集中'] : /read|open/i.test(name) ? ['Reading', 'を確認中'] : /search|grep|glob/i.test(name) ? ['Searching', 'を検索中'] : ['Running', 'を実行中'];
    return language === 'ja' ? `${target || name}${verb[1]}` : `${verb[0]} ${target || name}`;
  }
  return language === 'ja' ? '作業中' : 'Working';
}
export function readReport(state: ScreenState, conversationId: string): string {
  const ids = new Set((state.projection.message_memberships ?? []).filter(row => row.conversation_id === conversationId && row.active !== 0 && row.active !== false).map(row => row.message_id));
  return (state.projection.messages ?? []).filter(row => ids.has(row.id) && row.role === 'assistant')
    .toSorted((a, b) => readText(a.source_ts).localeCompare(readText(b.source_ts))).map(row => readBody(row.body).trim()).filter(Boolean).at(-1)?.split('\n')[0] ?? '';
}
export function readExpanded(values: string[]): Map<string, number> {
  return new Map(values.map(value => { const match = /^(.*)@(\d+)$/.exec(value); return match ? [match[1], Math.max(PAGE_SIZE, Number(match[2]))] : [value.replace(/^completed:/, 'today:'), PAGE_SIZE]; }));
}
/** 木の順序、畳み、役の絞り込みを両方の画面で共有する。 */
export function buildRows(tree: GraphTree, options: { now: number; expanded?: ReadonlyMap<string, number>; selected?: string; role?: ChildRole; state?: ScreenState; compact?: boolean }): GraphRows {
  const { now, selected, role, state } = options;
  const byId = new Map(tree.nodes.map(node => [node.id, { ...node, children: [...node.children], activity: readGraphActivity(node) }]));
  const all: GraphRow[] = [];
  const seen = new Set<string>();
  function visit(id: string, ancestors: string[]) {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const main = tree.roots.includes(id);
    const rowRole = main ? 'main' : node.role === 'planner' ? 'planner' : resolveChildRole({ role: node.role }, node.delegation);
    const running = ['starting', 'running'].includes(toDisplayState(node.state));
    all.push({ id, parent: ancestors.at(-1), depth: ancestors.length, ancestors, node, role: rowRole, runningBelow: 0, runningPath: running, selectedPath: id === selected,
      height: (running ? RUNNING_ROW_HEIGHT : GRAPH_ROW_HEIGHT) + (node.approvals?.length ?? 0) * APPROVAL_ROW_HEIGHT, segments: readSegments(node, now, state) });
    node.children.toSorted((a, b) => {
      const rank = (child: string) => ['starting', 'running'].includes(toDisplayState(byId.get(child)?.state ?? '')) ? 0 : ['waiting_approval', 'waiting_input'].includes(byId.get(child)?.state ?? '') ? 1 : 2;
      return rank(a) - rank(b) || readText(byId.get(b)?.activity).localeCompare(readText(byId.get(a)?.activity)) || a.localeCompare(b);
    }).forEach(child => visit(child, [...ancestors, id]));
  }
  tree.roots.forEach(id => visit(id, []));
  const rowsById = new Map(all.map(row => [row.id, row]));
  const roles: GraphRows['roles'] = {};
  const protectedIds = new Set<string>();
  const matches = new Set<string>();
  let running = 0; let needsYou = 0;
  for (const row of all) {
    const node = row.node!; const shown = toDisplayState(node.state);
    if (row.role !== 'main' && row.role !== 'planner') roles[row.role as ChildRole] = (roles[row.role as ChildRole] ?? 0) + 1;
    if (row.runningPath) { running++; for (const id of row.ancestors) { rowsById.get(id)!.runningBelow++; rowsById.get(id)!.runningPath = true; } }
    if (['waiting_approval', 'waiting_input'].includes(shown)) needsYou++;
    if (row.id === selected) row.ancestors.forEach(id => { rowsById.get(id)!.selectedPath = true; });
    if (['starting', 'running', 'waiting_approval', 'waiting_input', 'unknown'].includes(shown)
      || shown === 'failed' && Date.parse(node.activity ?? '') >= now - FAILURE_MS || node.role === 'planner') {
      [row.id, ...row.ancestors].forEach(id => protectedIds.add(id));
    }
    if (role && row.role === role) [row.id, ...row.ancestors].forEach(id => matches.add(id));
  }
  const rows: GraphRow[] = [];
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  function emit(parent: GraphRow) {
    if (role && !matches.has(parent.id)) return;
    rows.push(parent);
    const children = all.filter(row => row.parent === parent.id && (!role || matches.has(row.id)));
    if (role) { children.forEach(emit); return; }
    const completedGraph = parent.role === 'planner' && isCompletedGraph(parent.node!, byId);
    const recent = children.filter(row => !completedGraph && !protectedIds.has(row.id) && ['ended', 'idle'].includes(toDisplayState(row.node!.state)) && Date.parse(row.node!.activity ?? '') >= now - RECENT_MS).slice(0, RECENT_LIMIT);
    const groups = new Map<'today' | 'earlier', GraphRow[]>();
    for (const child of children) {
      if (!completedGraph && (protectedIds.has(child.id) || recent.includes(child))) { emit(child); continue; }
      const kind = !completedGraph && Date.parse(child.node!.activity ?? '') >= today.getTime() ? 'today' : 'earlier';
      groups.set(kind, [...groups.get(kind) ?? [], child]);
    }
    for (const kind of ['today', 'earlier'] as const) {
      const members = groups.get(kind);
      if (!members?.length) continue;
      const id = `${kind}:${parent.id}`;
      const selectedIndex = members.findIndex(row => row.id === selected || rowsById.get(selected ?? '')?.ancestors.includes(row.id));
      const shown = Math.min(members.length, Math.max(options.expanded?.get(id) ?? 0, selectedIndex < 0 ? 0 : Math.ceil((selectedIndex + 1) / PAGE_SIZE) * PAGE_SIZE));
      const groupRoles: GraphRows['roles'] = {};
      const descendants = all.filter(row => members.some(member => member.id === row.id || row.ancestors.includes(member.id)));
      for (const row of descendants) if (row.role !== 'main' && row.role !== 'planner') groupRoles[row.role as ChildRole] = (groupRoles[row.role as ChildRole] ?? 0) + 1;
      rows.push({ id, parent: parent.id, depth: parent.depth + 1, ancestors: [...parent.ancestors, parent.id], runningBelow: 0, runningPath: false, selectedPath: false, height: GRAPH_ROW_HEIGHT,
        segments: descendants.flatMap(row => row.segments), group: { kind, count: descendants.length, shown, roles: groupRoles, members: members.map(row => row.id) } });
      members.slice(0, shown).forEach(emit);
      if (shown > 0 && shown < members.length) rows.push({ id: `more:${id}`, parent: parent.id, depth: parent.depth + 1, ancestors: [...parent.ancestors, parent.id], runningBelow: 0, runningPath: false, selectedPath: false, height: GRAPH_ROW_HEIGHT, segments: [],
        group: { kind, count: descendants.length, shown, roles: {}, members: members.map(row => row.id), more: true, groupId: id } });
    }
  }
  all.filter(row => !row.parent).forEach(emit);
  if (options.compact) {
    for (const row of new Set([...rows, ...all])) row.height += COMPACT_ROW_EXTRA;
  }
  return { rows, all, running, needsYou, roles };
}
