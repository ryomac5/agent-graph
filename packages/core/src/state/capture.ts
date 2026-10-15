import type { JsonValue } from '../ledger/facts.ts';
import { readNativeEvidence } from './records.ts';
import type { NativeRecord } from './records.ts';

type Row = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): Row => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string') return '';
  const notification = value.trim().match(/^<task-notification>\s*<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(stopped|completed)<\/status>/u);
  if (notification) return `<task-notification><task-id>${notification[1]}</task-id><status>${notification[2]}</status></task-notification>`;
  const boundary = value.trim().match(/^(?:\[Request interrupted by user(?: for tool use)?\]|<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input)>)/u)?.[0];
  if (boundary) return boundary;
  return value ? 'observed' : '';
}
function content(value: JsonValue | undefined): JsonValue {
  if (!Array.isArray(value)) return text(value);
  return value.map(block => {
    const b = object(block);
    const result: Row = {};
    for (const key of ['type', 'id', 'name', 'tool_use_id', 'is_error']) if (b[key] !== undefined) result[key] = b[key];
    if (b.text !== undefined) result.text = text(b.text);
    if (b.input !== undefined) result.input = { ...(object(b.input).run_in_background !== undefined ? { run_in_background: object(b.input).run_in_background } : {}) };
    return result;
  });
}
/** 本文や tool 出力を複製せず、判定と相関に必要な構造だけ残す。 */
export function captureNativeRecord(source: NativeRecord['source'], row: Row): Row | undefined {
  const record: Row = {};
  for (const key of ['type', 'subtype', 'method', 'uuid', 'parentUuid', 'promptId', 'isMeta', 'isCompactSummary', 'isVisibleInTranscriptOnly', 'operation', 'timestamp', 'state', 'is_error'])
    if (row[key] !== undefined) record[key] = row[key];
  if (row.message) { const m = object(row.message); record.message = { role: m.role ?? null, content: content(m.content), stop_reason: m.stop_reason ?? null }; }
  if (row.content) record.content = text(row.content);
  if (row.attachment) { const a = object(row.attachment); record.attachment = { type: a.type ?? null, hookEvent: a.hookEvent ?? null, toolUseID: a.toolUseID ?? null, delivery_id: a.delivery_id ?? null, source_uuid: a.source_uuid ?? null }; }
  if (row.toolUseResult) { const r = object(row.toolUseResult); record.toolUseResult = { agentId: r.agentId ?? null, status: r.status ?? null, isAsync: r.isAsync ?? null, success: r.success ?? null, content: content(r.content) }; }
  for (const key of ['payload', 'params', 'result']) if (row[key]) {
    const p = object(row[key]);
    record[key] = Object.fromEntries(Object.entries(p).filter(([key]) => ['type', 'turn_id', 'turnId', 'phase', 'role', 'call_id', 'id'].includes(key)));
    if (p.turn) { const turn = object(p.turn); object(record[key]).turn = { id: turn.id ?? null, status: turn.status ?? null }; }
    if (p.status) { const status = object(p.status); object(record[key]).status = typeof p.status === 'string' ? p.status : { type: status.type ?? null, activeFlags: status.activeFlags ?? [] }; }
    if (p.item) {
      const item = object(p.item);
      const captured = Object.fromEntries(Object.entries(item).filter(([key]) => ['type', 'id', 'phase', 'role', 'status', 'tool', 'receiverThreadIds', 'kind', 'agent_thread_id'].includes(key)));
      if (item.agentsStates) captured.agentsStates = Object.fromEntries(Object.entries(object(item.agentsStates)).map(([id, state]) => [id, { status: object(state).status ?? null, message: text(object(state).message) }]));
      object(record[key]).item = captured;
    }
  }
  const signals = readNativeEvidence({ source, row: record, id: 'record', at: 0, observedAt: 0, runId: 'run' });
  if (object(record.attachment).type === 'queued_command' || signals.length || String(record.content ?? JSON.stringify(record.message)).includes('<task-notification>')) return record;
  // 信号のない行は UUID の辺と turn の境界だけを残す。添付や発言の殻を保存しない。
  if (source === 'claude' && typeof row.uuid === 'string' && (typeof row.parentUuid === 'string' || typeof row.promptId === 'string')) return Object.fromEntries(
    ['uuid', 'parentUuid', 'promptId'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  if (row.type === 'turn_context') {
    const payload = object(row.payload);
    if (typeof payload.turn_id === 'string') return { type: 'turn_context', payload: { turn_id: payload.turn_id } };
  }
  return undefined;
}
