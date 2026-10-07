import { readTitle } from '../lib/format.ts';
import { getRegisteredProjects, isTemporaryPath, OTHER_PROJECT } from '../lib/projects.ts';
import type { Row, ScreenState } from '../lib/store.ts';
import type { ExecutionState } from './StateBadge.tsx';
import { readBody } from '../lib/message-body.ts';
export { readBody } from '../lib/message-body.ts';

export const executionStates: ExecutionState[] = ['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'ended', 'failed', 'unknown'];
export type ActivitySection = 'managed' | 'external' | 'unattended' | 'unsupported';
export interface Activity {
  id: string; parentConversationId?: string; taskId?: string; conversationId?: string; project: string; name: string;
  temporary?: boolean; lastActivity?: string; excerpt?: string; provisional: boolean; provider: string; model: string; effort: string; state: ExecutionState;
  section: ActivitySection; managed: boolean; run?: Row; messages: Row[]; artifacts: Row[];
}
export function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    const row = value as Row;
    return readText(row.text ?? row.content);
  }
  return '';
}
export function readObject(value: unknown): Row {
  value = decodeStoredValue(value);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
export function decodeStoredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // api の snapshot は SQLite の JSON 列を文字列のまま返す。
  try { return JSON.parse(value); } catch { return value; }
}
function groupRows(rows: Row[], field: string): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const id = readText(row[field]);
    const group = groups.get(id) ?? [];
    group.push(row); groups.set(id, group);
  }
  return groups;
}
export function selectActivities(state: ScreenState, parallel = false): Activity[] {
  const p = state.projection;
  const projects = new Map((p.projects ?? []).map(row => [readText(row.id), row]));
  const registered = new Set(getRegisteredProjects(state).map(row => readText(row.id)));
  const tasks = new Map((p.tasks ?? []).map(row => [readText(row.id), row]));
  const messages = new Map((p.messages ?? []).map(row => [readText(row.id), row]));
  const memberships = groupRows((p.message_memberships ?? []).filter(row => row.active === 1 || row.active === true), 'conversation_id');
  const runs = groupRows(p.runs ?? [], 'conversation_id');
  const artifacts = groupRows(p.artifacts ?? [], 'run_id');
  const assigned = new Map<string, Row>();
  for (const delegation of p.delegations ?? []) {
    const attempts = decodeStoredValue(delegation.attempts);
    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      const row = readObject(attempt);
      assigned.set(readText(row.run_id), readObject(row.assignment));
    }
  }
  const seenTasks = new Set<string>();
  const result: Activity[] = [];
  for (const conversation of p.conversations ?? []) {
    const conversationId = readText(conversation.id);
    const taskId = readText(conversation.task_id);
    const task = tasks.get(taskId);
    const projectId = readText(conversation.project) || readText(task?.project);
    const project = projects.get(projectId);
    seenTasks.add(taskId);
    const history = (memberships.get(conversationId) ?? []).flatMap(link => {
      const message = messages.get(readText(link.message_id));
      return message ? [message] : [];
    }).sort((a, b) => readText(a.source_ts).localeCompare(readText(b.source_ts)) || readText(a.id).localeCompare(readText(b.id)));
    const first = readText(conversation.first_request_excerpt) || history.filter(row => row.role === 'user' || !row.role).map(row => readBody(row.body)).find(Boolean)?.trim().split(/(?<=[。.!?？！])|\n/u)[0];
    const orderedRuns = [...(runs.get(conversationId) ?? [])].sort((a, b) => Number(b.generation ?? 0) - Number(a.generation ?? 0) || readText(b.started_ts).localeCompare(readText(a.started_ts)));
    const displayedRuns = parallel ? orderedRuns.filter(run => Number(run.generation ?? 0) === Number(orderedRuns[0]?.generation ?? 0)) : orderedRuns.slice(0, 1);
    for (const run of displayedRuns.length ? displayedRuns : [undefined]) {
      const assignment = assigned.get(readText(run?.id));
      const launch = readObject(run?.launch);
      const rawState = readText(run?.state ?? task?.state);
      const format = readText(conversation.history_format);
      const location = readText(project?.root_path) || readText(launch.cwd ?? run?.cwd ?? run?.worktree_path ?? conversation.cwd ?? conversation.root_path) || (projectId.startsWith('/') ? projectId : '');
      const unsupported = Boolean(format && !['jsonl', 'legacy', 'paginated'].includes(format))
        || format === 'paginated' && conversation.origin === 'observed' && !Number(conversation.message_count) && !history.some(message => message.body_state === 'stored' || readBody(message.body));
      const section: ActivitySection = unsupported ? 'unsupported'
        : conversation.type === 'unattended' ? 'unattended' : conversation.origin === 'observed' ? 'external' : 'managed';
      result.push({ id: readText(run?.id) || conversationId, taskId, conversationId,
        project: registered.has(projectId) ? projectId : OTHER_PROJECT,
        temporary: project?.reason === 'temporary' || conversation.project_reason === 'temporary' || isTemporaryPath(location),
        lastActivity: [conversation.last_message_ts, run?.last_evidence_ts, run?.ended_ts, run?.started_ts, conversation.created_ts].map(readText).filter(Boolean).sort().at(-1),
        excerpt: readText(conversation.last_message_excerpt),
        name: readTitle(task?.name) || readTitle(conversation.name) || first || readText(conversation.last_message_excerpt) || readText(task?.purpose) || 'New conversation',
        provisional: !readTitle(task?.name) && (!readTitle(conversation.name) || conversation.name_is_provisional === true || conversation.name_is_provisional === 1),
        provider: readText(conversation.provider),
        // 起動の記録がない実行は、モデルを空にして画面に「記録なし」と出す。
        model: readText(assignment?.model) || readText(readObject(launch.model).model) || readText(conversation.model),
        effort: readText(assignment?.effort) || readText(readObject(launch.model).effort),
        state: executionStates.includes(rawState as ExecutionState) ? rawState as ExecutionState : 'unknown',
        section, managed: conversation.origin === 'managed', run, messages: history, artifacts: artifacts.get(readText(run?.id)) ?? [],
      });
    }
  }
  for (const [id, task] of tasks) {
    if (seenTasks.has(id)) continue;
    result.push({ id, taskId: id, project: registered.has(readText(task.project)) ? readText(task.project) : OTHER_PROJECT, temporary: isTemporaryPath(readText(projects.get(readText(task.project))?.root_path) || readText(task.project)), lastActivity: readText(task.updated_ts ?? task.created_ts), name: readTitle(task.name) || readText(task.purpose) || 'New task',
      provisional: !readTitle(task.name), provider: '', model: '', effort: '',
      state: executionStates.includes(task.state as ExecutionState) ? task.state as ExecutionState : 'unknown',
      section: 'managed', managed: true, messages: [], artifacts: [] });
  }
  // review_of はレビューから対象への向き。所属と表示順は対象の作業から辿る。
  for (const relation of p.relations ?? []) {
    if (relation.type !== 'review_of' || ![true, 1].includes(relation.active as boolean | number) || relation.confidence !== 'confirmed') continue;
    const parent = result.find(item => item.conversationId === relation.to_id);
    if (!parent) continue;
    for (const child of result.filter(item => item.conversationId === relation.from_id)) {
      child.parentConversationId = parent.conversationId;
      child.taskId = parent.taskId;
      child.project = parent.project;
      child.lastActivity = child.lastActivity || parent.lastActivity;
      child.temporary = parent.temporary;
      child.name = `Review of ${parent.name}`;
      child.provisional = parent.provisional;
    }
  }
  return result;
}
/** 成果物がないときは undefined を返す。画面は「成果物なし」と出す。 */
export function summarizeChanges(artifacts: Row[]): string | undefined {
  if (!artifacts.length) return;
  let files = 0; let added = 0; let removed = 0;
  const latest = new Map<string, Row>();
  for (const artifact of artifacts) {
    const key = readText(artifact.run_id);
    if (Number(artifact.version ?? 0) >= Number(latest.get(key)?.version ?? 0)) latest.set(key, artifact);
  }
  for (const artifact of latest.values()) {
    const diff = readText(artifact.diff);
    files += diff.split('\n').filter(line => line.startsWith('diff --git ')).length;
    added += diff.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
    removed += diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  }
  if (![...latest.values()].some(row => typeof row.diff === 'string')) return;
  return `${files} ${files === 1 ? 'file' : 'files'} · +${added} −${removed}`;
}

export function orderActivities(items: Activity[]): Activity[] {
  const ordered: Activity[] = [];
  const visited = new Set<string>();
  const conversations = new Set(items.map(item => item.conversationId));
  const children = new Map<string, Activity[]>();
  for (const item of items) if (item.parentConversationId) {
    const group = children.get(item.parentConversationId) ?? [];
    group.push(item); children.set(item.parentConversationId, group);
  }
  function append(item: Activity) {
    if (visited.has(item.id)) return;
    visited.add(item.id); ordered.push(item);
    for (const child of children.get(item.conversationId ?? '') ?? []) append(child);
  }
  for (const item of items) if (!item.parentConversationId || !conversations.has(item.parentConversationId)) append(item);
  for (const item of items) append(item);
  return ordered;
}
