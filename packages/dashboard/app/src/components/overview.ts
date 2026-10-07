import { selectRegisteredProject, OTHER_PROJECT } from '../lib/projects.ts';
import type { ScreenState } from '../lib/store.ts';
import { ACTIVE_EXECUTION_STATES, toExecutionState, type DelegationTree, type TreeNode } from '../pages/tree/model.ts';
import type { ExecutionState } from './StateBadge.tsx';
import { isCurrentTerminal, readText, type Activity } from './activity.ts';

/** 委譲の 1 行。誰に何を頼み、どこまで進んだかを、展開せずに読める形にする。 */
export interface DelegationLine {
  id: string; node: TreeNode; state: ExecutionState; attempts: number;
  active: boolean; children: DelegationLine[];
}
/** 一覧の作業の行と、その作業から出た委譲の木。 */
export interface WorkItem { activity: Activity; delegations: DelegationLine[]; active: boolean }
export interface ProjectGroup { id: string; items: WorkItem[]; unlinked: DelegationLine[]; running: number; waiting: number }
export interface Overview { projects: ProjectGroup[]; external: WorkItem[]; unattended: WorkItem[]; unsupported: WorkItem[] }

const WAITING_STATES = ['waiting_approval', 'waiting_input'];
export function isActiveState(state: string): boolean { return ACTIVE_EXECUTION_STATES.includes(state); }

function countDelegations(lines: DelegationLine[], states: readonly string[]): number {
  return lines.reduce((total, line) => total + Number(states.includes(line.state)) + countDelegations(line.children, states), 0);
}
export function countActiveDelegations(lines: DelegationLine[]): number { return countDelegations(lines, ACTIVE_EXECUTION_STATES); }
export function countAllDelegations(lines: DelegationLine[]): number {
  return lines.reduce((total, line) => total + 1 + countAllDelegations(line.children), 0);
}

/**
 * 一覧を設計書の形に組む。作業はプロジェクトごとの区画に置き、その下に委譲の木を付ける。
 * 古い外の端末の会話と無人実行は別の区画に置く。外の会話でも、作業として名前があるものと委譲を起こしたものは作業として扱う。
 * 委譲で起きた会話は、行としては出さず、親の作業の木の中に出す。
 */
export function buildOverview(state: ScreenState, activities: Activity[], tree: DelegationTree, now = Date.now()): Overview {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  // レビュアーの関係は作業の子の行として出すので、委譲の行には含めない。
  const isLine = (node: TreeNode) => Boolean(node.delegation) || node.role !== 'Reviewer';
  function lineOf(node: TreeNode): DelegationLine {
    const executionState = toExecutionState(node.state);
    const children = linesUnder(node.id, node.conversationId);
    return { id: node.id, node, state: executionState, children,
      attempts: node.delegation ? node.attempts.length || Number(node.delegation.attempt ?? 0) : 1,
      active: isActiveState(executionState) || children.some(child => child.active) };
  }
  // 会話の自身の実行の世代は木の行にせず、その下の委譲だけを並べる。
  function linesUnder(id: string, conversationId?: string, seen = new Set<string>()): DelegationLine[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const lines: DelegationLine[] = [];
    for (const childId of byId.get(id)?.children ?? []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (!child.delegation && child.kind === 'run' && (child.conversationId === conversationId || child.role === 'Reviewer')) {
        lines.push(...linesUnder(child.id, conversationId, seen));
      } else if (isLine(child)) lines.push(lineOf(child));
    }
    return lines.sort(compareLines);
  }
  const delegated = new Set<string>();
  function collect(lines: DelegationLine[]) {
    for (const line of lines) {
      if (line.node.conversationId) delegated.add(line.node.conversationId);
      collect(line.children);
    }
  }
  const rootLines = new Map<string, DelegationLine[]>();
  for (const activity of activities) {
    if (!activity.conversationId || rootLines.has(activity.conversationId)) continue;
    const lines = linesUnder(`conversation:${activity.conversationId}`, activity.conversationId);
    const run = activity.run ? linesUnder(`run:${readText(activity.run.id)}`, activity.conversationId) : [];
    const merged = [...new Map([...lines, ...run].map(line => [line.id, line])).values()].sort(compareLines);
    rootLines.set(activity.conversationId, merged);
    collect(merged);
  }
  // 親が確定しない委譲は、その会話が作業の行として出ないものだけを、区画の別の枝に置く。
  const rows = new Set(activities.flatMap(activity => activity.conversationId && !delegated.has(activity.conversationId) ? [activity.conversationId] : []));
  const unresolved = tree.unresolved.flatMap(id => {
    const node = byId.get(id);
    return node && !(node.conversationId && rows.has(node.conversationId)) ? [lineOf(node)] : [];
  });
  const groups = new Map<string, ProjectGroup>();
  const group = (id: string) => {
    let entry = groups.get(id);
    if (!entry) { entry = { id, items: [], unlinked: [], running: 0, waiting: 0 }; groups.set(id, entry); }
    return entry;
  };
  const external: WorkItem[] = [];
  const unattended: WorkItem[] = [];
  const unsupported: WorkItem[] = [];
  for (const activity of activities) {
    // 委譲で起きた会話と、その会話の子は親の木に出す。
    if (activity.conversationId && delegated.has(activity.conversationId)) continue;
    if (activity.parentConversationId && delegated.has(activity.parentConversationId)) continue;
    const delegations = activity.conversationId ? rootLines.get(activity.conversationId) ?? [] : [];
    const item: WorkItem = { activity, delegations, active: isActiveState(activity.state) || delegations.some(line => line.active) };
    if (activity.section === 'unsupported') unsupported.push(item);
    else if (activity.section === 'unattended' && !delegations.length) unattended.push(item);
    else if (activity.section === 'external' && !activity.taskId && !delegations.length && !activity.parentConversationId && !isCurrentTerminal(activity, now)) external.push(item);
    else group(activity.project).items.push(item);
  }
  for (const line of unresolved) {
    const delegation = line.node.delegation;
    const conversation = state.projection.conversations?.find(row => row.id === line.node.conversationId);
    group(selectRegisteredProject(state, [delegation?.project, delegation?.repository_id, line.node.run?.repository_id,
      conversation?.project, conversation?.repository_id])).unlinked.push(line);
  }
  for (const entry of groups.values()) {
    entry.items.sort(compareItems);
    entry.unlinked.sort(compareLines);
    entry.running = entry.items.filter(item => ['starting', 'running'].includes(item.activity.state)).length
      + entry.items.reduce((total, item) => total + countDelegations(item.delegations, ['starting', 'running']), 0)
      + countDelegations(entry.unlinked, ['starting', 'running']);
    entry.waiting = entry.items.filter(item => WAITING_STATES.includes(item.activity.state)).length
      + entry.items.reduce((total, item) => total + countDelegations(item.delegations, WAITING_STATES), 0)
      + countDelegations(entry.unlinked, WAITING_STATES);
  }
  const projects = [...groups.values()].sort((a, b) => Number(a.id === OTHER_PROJECT) - Number(b.id === OTHER_PROJECT)
    || Number(b.running + b.waiting > 0) - Number(a.running + a.waiting > 0));
  for (const list of [external, unattended, unsupported]) list.sort(compareItems);
  return { projects, external, unattended, unsupported };
}

function lastActivity(item: WorkItem): number { return Date.parse(item.activity.lastActivity ?? '') || 0; }
function priority(state: string): number {
  return WAITING_STATES.includes(state) ? 2 : isActiveState(state) ? 1 : 0;
}
/** 承認と入力の待ち、動いているもの、止まっているものの順にし、同じ順位では新しい順にする。 */
export function compareItems(a: WorkItem, b: WorkItem): number {
  const rank = (item: WorkItem) => Math.max(priority(item.activity.state), item.active ? 1 : 0);
  return rank(b) - rank(a) || priority(b.activity.state) - priority(a.activity.state) || lastActivity(b) - lastActivity(a) || a.activity.name.localeCompare(b.activity.name);
}
function compareLines(a: DelegationLine, b: DelegationLine): number {
  return priority(b.state) - priority(a.state) || Number(b.active) - Number(a.active) || a.node.label.localeCompare(b.node.label);
}
