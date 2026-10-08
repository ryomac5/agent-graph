import type { Row, ScreenState } from '../../lib/store.ts';
import { providerName } from '../ActivityRow.tsx';
import { decodeStoredValue, isActive, readBody, readObject, readText } from './model.ts';
import { harnessKind } from '../../lib/message-body.ts';

/** 会話の両側の名前。子の会話では、右は親のエージェント、左は子のエージェントになる。 */
export interface Participants { child: boolean; parent: string; self: string }
export interface Sender { key: string; name: string; side: 'start' | 'end' }

interface ParentLink { parentId?: string; role: string }

function conversationOf(state: ScreenState, id: unknown): string | undefined {
  const raw = readText(id);
  if (!raw) return;
  const value = state.identities?.conversations[raw] ?? raw;
  if ((state.projection.conversations ?? []).some(row => row.id === value)) return value;
  const runId = state.identities?.runs[raw] ?? raw;
  const run = (state.projection.runs ?? []).find(row => row.id === runId);
  return run ? readText(run.conversation_id) || undefined : undefined;
}

function attemptRuns(delegation: Row): string[] {
  const attempts = decodeStoredValue(delegation.attempts);
  return (Array.isArray(attempts) ? attempts.map(readObject) : []).map(attempt => readText(attempt.run_id)).filter(Boolean);
}

/** 委譲の役割は、関係の根拠の依頼 ID か、委譲の試行の実行から引く。 */
function delegationRole(state: ScreenState, conversationId: string, evidence: Row): string {
  const delegations = state.projection.delegations ?? [];
  const requests = [evidence.request_id, evidence.tool_use_id, evidence.task_id].map(readText).filter(Boolean);
  const byRequest = delegations.find(row => requests.includes(readText(row.request_id)));
  const byRun = delegations.find(row => attemptRuns(row).some(run => conversationOf(state, run) === conversationId));
  return readText((byRequest ?? byRun)?.role);
}

/** 親の会話への結び付きを探す。確定した関係を推定より先に使う。 */
function parentLink(state: ScreenState, conversationId: string): ParentLink | undefined {
  const relations = (state.projection.relations ?? []).filter(row => isActive(row.active) || row.active === undefined)
    .toSorted((a, b) => Number(b.confidence === 'confirmed') - Number(a.confidence === 'confirmed'));
  for (const relation of relations) {
    if (relation.type === 'delegated' && conversationOf(state, relation.to_id) === conversationId) {
      const parentId = conversationOf(state, relation.from_id);
      if (parentId === conversationId) continue;
      return { parentId, role: readText(readObject(relation.evidence).agentType ?? readObject(relation.evidence).role) || delegationRole(state, conversationId, readObject(relation.evidence)) || 'subagent' };
    }
    if (relation.type === 'review_of' && conversationOf(state, relation.from_id) === conversationId) {
      const parentId = conversationOf(state, relation.to_id);
      if (parentId !== conversationId) return { parentId, role: 'review' };
    }
  }
  const delegation = (state.projection.delegations ?? []).find(row => attemptRuns(row).some(run => conversationOf(state, run) === conversationId) || row.conversation_id === conversationId);
  const parentId = delegation ? conversationOf(state, delegation.parent_run_id) : undefined;
  if (parentId && parentId !== conversationId) return { parentId, role: readText(delegation?.role) || 'subagent' };
}

function label(provider: string, role: string): string {
  return [providerName(provider) || 'Agent', role].filter(Boolean).join(' · ');
}

export function resolveParticipants(state: ScreenState, conversationId: string, labels: { user: string; assistant: string; parent: string }): Participants {
  const conversations = state.projection.conversations ?? [];
  const conversation = conversations.find(row => row.id === conversationId);
  const provider = readText(conversation?.provider);
  const link = parentLink(state, conversationId);
  const child = conversation?.type === 'subagent' || link !== undefined;
  if (!child) return { child, parent: labels.user, self: providerName(provider) || labels.assistant };
  const parent = link?.parentId ? conversations.find(row => row.id === link.parentId) : undefined;
  // 親がさらに子なら、その役割を出す。辿れない親は根として扱う。
  const parentRole = link?.parentId ? parentLink(state, link.parentId)?.role ?? 'root' : '';
  return {
    child,
    parent: parent ? label(readText(parent.provider), parentRole) : labels.parent,
    self: label(provider, link?.role ?? 'subagent'),
  };
}

/** 道具の結果だけの発言は、利用者ではなくエージェントの列に置く。 */
function userAuthored(row: Row): boolean {
  if (!Array.isArray(row.body)) return true;
  return row.body.map(readObject).some(block => block.type !== 'tool_result');
}

export function senderOf(row: Row, participants: Participants): Sender {
  const role = readText(row.role) || 'assistant';
  if (role === 'user' && userAuthored(row)) {
    // 子の報告と裏の作業の通知は、利用者の行として届くが人の発言ではない。エージェントの側に別の形で置く。
    const kind = harnessKind(readBody(row.body));
    if (kind === 'agent_report') return { key: 'agent_report', name: 'Agent report', side: 'start' };
    if (kind === 'notification') return { key: 'notification', name: 'Notification', side: 'start' };
    return { key: 'end', name: participants.parent, side: 'end' };
  }
  if (role === 'user' || role === 'assistant') return { key: 'start', name: participants.self, side: 'start' };
  return { key: `role:${role}`, name: role.charAt(0).toUpperCase() + role.slice(1), side: 'start' };
}
