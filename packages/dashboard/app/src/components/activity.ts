import type { Row, ScreenState } from '../lib/store.ts';
import type { ExecutionState } from './StateBadge.tsx';

export const executionStates: ExecutionState[] = ['starting', 'running', 'waiting_approval', 'waiting_input', 'idle', 'ended', 'failed', 'unknown'];
export type ActivitySection = 'managed' | 'external' | 'unattended' | 'unsupported';
export interface Activity {
  id: string; taskId?: string; conversationId?: string; project: string; name: string;
  provisional: boolean; provider: string; model: string; effort: string; state: ExecutionState;
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
export function readBody(value: unknown): string { return readText(decodeStoredValue(value)); }
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
    seenTasks.add(taskId);
    const history = (memberships.get(conversationId) ?? []).flatMap(link => {
      const message = messages.get(readText(link.message_id));
      return message ? [message] : [];
    }).sort((a, b) => readText(a.source_ts).localeCompare(readText(b.source_ts)) || readText(a.id).localeCompare(readText(b.id)));
    const first = history.map(row => readBody(row.body)).find(Boolean)?.trim().split(/(?<=[。.!?？！])|\n/u)[0];
    const orderedRuns = [...(runs.get(conversationId) ?? [])].sort((a, b) => Number(b.generation ?? 0) - Number(a.generation ?? 0) || readText(b.started_ts).localeCompare(readText(a.started_ts)));
    const displayedRuns = parallel ? orderedRuns.filter(run => Number(run.generation ?? 0) === Number(orderedRuns[0]?.generation ?? 0)) : orderedRuns.slice(0, 1);
    for (const run of displayedRuns.length ? displayedRuns : [undefined]) {
      const assignment = assigned.get(readText(run?.id));
      const launch = readObject(run?.launch);
      const rawState = readText(run?.state ?? task?.state);
      const format = readText(conversation.history_format);
      const unsupported = Boolean(format && !['jsonl', 'legacy', 'paginated'].includes(format))
        || format === 'paginated' && conversation.origin === 'observed' && !history.some(message => message.body_state === 'stored' || readBody(message.body));
      const section: ActivitySection = unsupported ? 'unsupported'
        : conversation.type === 'unattended' ? 'unattended' : conversation.origin === 'observed' ? 'external' : 'managed';
      result.push({ id: readText(run?.id) || conversationId, taskId, conversationId,
        project: readText(task?.project) || readText(conversation.project),
        name: readText(task?.name) || readText(conversation.name) || first || 'Untitled conversation',
        provisional: !readText(task?.name) && (!readText(conversation.name) || conversation.name_is_provisional === true || conversation.name_is_provisional === 1),
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
    result.push({ id, taskId: id, project: readText(task.project), name: readText(task.name) || readText(task.purpose) || 'Untitled task',
      provisional: !task.name, provider: '', model: '', effort: '',
      state: executionStates.includes(task.state as ExecutionState) ? task.state as ExecutionState : 'unknown',
      section: 'managed', managed: true, messages: [], artifacts: [] });
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
