import type { createClient } from '../../lib/client.ts';
import type { Row, ScreenState } from '../../lib/store.ts';
import { decodeStoredValue } from '../../components/activity.ts';

export type CommandClient = Pick<ReturnType<typeof createClient>, 'command'>;
export type ApprovalAction = 'allow' | 'deny' | 'session';
export const APPROVAL_KEYS = { allow: 'a', deny: 'd', session: 's' } as const;
const PENDING = new Set(['pending', 'requested', 'waiting', 'waiting_approval']);
export function isPending(row: Row) { return PENDING.has(String(row.state)); }
export function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value, null, 2);
}
export function getConversation(row: Row, state: ScreenState): string {
  return readText(row.conversation_id ?? state.projection.runs?.find(run => run.id === row.run_id)?.conversation_id);
}
export function getRequestedTime(row: Row, state: ScreenState): string {
  const run = state.projection.runs?.find(run => run.id === row.run_id);
  return readText(row.requested_ts ?? row.created_ts ?? row.source_ts
    ?? (run?.state === 'waiting_approval' ? run.last_evidence_ts : undefined));
}
export function getInbox(state: ScreenState) {
  const rows = [...(state.projection.approvals ?? [])].sort((a, b) => {
    const left = Date.parse(getRequestedTime(a, state));
    const right = Date.parse(getRequestedTime(b, state));
    return (Number.isFinite(left) ? left : Infinity) - (Number.isFinite(right) ? right : Infinity)
      || String(a.id).localeCompare(String(b.id));
  });
  return { pending: rows.filter(isPending), expired: rows.filter(row => row.state === 'expired') };
}
export function getDecision(row: Row, action: ApprovalAction): string | undefined {
  const candidates = action === 'allow' ? ['allow', 'accept'] : action === 'deny' ? ['deny', 'decline']
    : ['acceptForSession', 'allow_for_session', 'allowForSession'];
  const decisions = decodeStoredValue(row.available_decisions);
  return Array.isArray(decisions)
    ? decisions.find((value): value is string => typeof value === 'string' && candidates.includes(value)) : undefined;
}
export async function answerApproval(client: CommandClient, row: Row, action: ApprovalAction) {
  const decision = getDecision(row, action);
  if (!isPending(row) || !decision) throw new Error('This decision is not available.');
  const ack = await client.command('answer', { approvalId: String(row.id), decision });
  if (!ack.ok) throw new Error(ack.error ?? 'Approval answer failed.');
}
