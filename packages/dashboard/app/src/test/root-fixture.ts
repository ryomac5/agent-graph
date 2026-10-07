import type { ScreenStore, Row } from '../lib/store.ts';
import { readAttempts } from '../pages/tree/model.ts';
import { readObject, readText } from '../components/conversation/model.ts';

// 旧い試験にも新しい api の投影契約を配る。根は試験側で明示する。
export function projectRoots(target: ScreenStore, ids: string[]) {
  const state = target.getSnapshot(); const p = state.projection;
  const conversations = new Map((p.conversations ?? []).map(row => [readText(row.id), row]));
  const runs = new Map<string, Row>();
  for (const row of p.runs ?? []) if (!runs.has(readText(row.conversation_id)) || Number(row.generation ?? 0) >= Number(runs.get(readText(row.conversation_id))?.generation ?? 0)) runs.set(readText(row.conversation_id), row);
  const runConversations = new Map((p.runs ?? []).map(row => [readText(row.id), readText(row.conversation_id)]));
  const sourceRelations = [...(p.relations ?? [])];
  for (const delegation of p.delegations ?? []) {
    const parent = readObject(delegation.parent); const origin = readObject(delegation.origin);
    const from = readText(parent.conversation_id) || runConversations.get(readText(parent.run_id ?? delegation.parent_run_id))
      || ids.find(id => conversations.get(id)?.native_id === origin.native_id) || (ids.includes(readText(origin.native_id)) ? readText(origin.native_id) : '');
    const to = runConversations.get(readText(readAttempts(delegation).at(-1)?.run_id));
    if (from && to && !sourceRelations.some(row => row.type === 'delegated' && row.from_id === from && row.to_id === to)) sourceRelations.push({ id: 'fixture:' + delegation.id, type: 'delegated', from_id: from, to_id: to, evidence: { request_id: delegation.request_id } });
  }
  const relations: Row[] = sourceRelations.map(row => {
    const evidence = readObject(row.evidence);
    const delegation = p.delegations?.find(item => item.request_id === evidence.request_id);
    return { ...row, evidence: { ...evidence, description: delegation?.title ?? evidence.description, agentType: delegation?.role ?? evidence.agentType } };
  });
  const roots = ids.map(id => {
    const c = conversations.get(id); const run = runs.get(id); const task = p.tasks?.find(row => row.id === c?.task_id);
    return { id, name: readText(c?.name) || 'Agent root', project: c?.project ?? task?.project ?? 'other', state: readText(run?.state) || 'unknown', last_activity_ts: run?.last_evidence_ts ?? c?.last_message_ts ?? null,
      conversation_ids: [id], running_children: 0, total_children: 0 };
  });
  const delegations = (p.delegations ?? []).map(row => {
    const parent = readObject(row.parent); const origin = readObject(row.origin);
    let root = readText(parent.conversation_id);
    if (!root) root = ids.find(id => conversations.get(id)?.native_id === origin.native_id) ?? '';
    return { ...row, root_id: ids.includes(root) ? root : row.root_id };
  });
  for (const root of roots) {
    const visited = new Set([root.id]);
    function visit(id: string) { for (const row of relations) if (row.type === 'delegated' && row.from_id === id && !visited.has(String(row.to_id))) { visited.add(String(row.to_id)); visit(String(row.to_id)); } }
    visit(root.id); root.total_children = visited.size - 1;
    root.running_children = [...visited].filter(id => id !== root.id && runs.get(id)?.state === 'running').length;
  }
  target.setSnapshot({ ...state, projection: { ...p, roots, relations, delegations } });
  return target;
}
