import { compareEventOrder } from '../../../../../core/src/ledger/event-order.ts';
import type { Row, ScreenState } from '../../lib/store.ts';
export { readBody } from '../../lib/message-body.ts';

export function decodeStoredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  // snapshot の SQLite JSON 列と、既に展開された patch の両方を受ける。
  try { return JSON.parse(value); } catch { return value; }
}
export function readObject(value: unknown): Row {
  const decoded = decodeStoredValue(value);
  return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Row : {};
}
export function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function showValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
}
export function isActive(value: unknown): boolean { return value === true || value === 1; }
export const ACTIVE_STATES = ['starting', 'running', 'waiting_approval', 'waiting_input'];
export const PENDING_APPROVALS = ['pending', 'requested', 'waiting', 'waiting_approval'];
export const PREVIEW_LINES = 10;

export interface TimelineEntry { kind: 'message' | 'approval' | 'boundary' | 'gap'; row: Row; time: string; key: string }
export function selectTimeline(state: ScreenState, conversationId: string): TimelineEntry[] {
  const p = state.projection;
  const ids = new Set((p.message_memberships ?? []).filter(row => row.conversation_id === conversationId && isActive(row.active)).map(row => row.message_id));
  const runIds = new Set((p.runs ?? []).filter(row => row.conversation_id === conversationId).map(row => row.id));
  const entries: TimelineEntry[] = [];
  function append(kind: TimelineEntry['kind'], row: Row) {
    const evidence = readObject(row.evidence);
    const decoded = { ...row };
    for (const field of ['body', 'tool_output', 'request', 'available_decisions']) {
      if (field in decoded) decoded[field] = decodeStoredValue(decoded[field]);
    }
    entries.push({ kind, row: decoded, key: `${kind}:${row.id}`, time: readText(row.source_ts ?? row.requested_ts ?? row.created_ts ?? evidence.source_ts ?? evidence.timestamp) });
  }
  for (const row of p.messages ?? []) if (ids.has(row.id)) {
    append('message', row);
    if (row.body_state === 'unavailable' || row.body_state === 'omitted') append('gap', {
      id: `body:${row.id}`, from: row.native_id ?? row.id, to: row.native_id ?? row.id,
      source_ts: row.source_ts, reason: row.body_state,
    });
  }
  for (const row of p.approvals ?? []) if (row.conversation_id === conversationId || runIds.has(row.run_id)) append('approval', row);
  for (const row of p.relations ?? []) if (isActive(row.active) && ['continued', 'forked', 'compacted', 'adopted'].includes(readText(row.type))
    && (row.from_id === conversationId || row.to_id === conversationId || runIds.has(row.to_id))) append('boundary', row);
  for (const row of p.observation_gaps ?? []) if (row.conversation_id === conversationId) append('gap', row);
  return entries.sort((a, b) => {
    // 時刻が配られていない項目は時刻不明とし、順序を捏造しない。
    // 同じ時刻の項目は出所の識別子で並べ、旧い Codex の行の位置を数として比べる。
    const tie = compareEventOrder(readText(a.row.source_event_id), readText(b.row.source_event_id)) || compareEventOrder(a.key, b.key);
    if (!a.time || !b.time) return Number(Boolean(b.time)) - Number(Boolean(a.time)) || tie;
    const difference = Date.parse(a.time) - Date.parse(b.time);
    return (Number.isFinite(difference) ? difference : a.time.localeCompare(b.time)) || tie;
  });
}
