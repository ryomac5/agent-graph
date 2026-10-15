import assert from 'node:assert/strict';
import test from 'node:test';
import { captureNativeRecord } from '../../src/state/capture.ts';
import { readNativeEvidence, type NativeRecord } from '../../src/state/records.ts';

for (const [source, row] of [
  ['claude', { type: 'user', uuid: 'user', promptId: 'turn', message: { content: '<private>secret</private>' } }],
  ['claude', { type: 'user', promptId: 'turn', message: { content: '[Request interrupted by user] secret' } }],
  ['claude', { type: 'assistant', promptId: 'turn', message: { content: [{ type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'secret' } }] } }],
  ['claude_sdk', { type: 'system', subtype: 'session_state_changed', state: 'requires_action', secret: 'secret' }],
  ['codex', { method: 'turn/completed', params: { turn: { id: 'turn', status: 'interrupted', items: [{ text: 'secret' }] } } }],
  ['codex', { method: 'thread/status/changed', params: { turnId: 'turn', status: { type: 'active', activeFlags: ['waitingOnApproval'], secret: 'secret' } } }],
] as const) test(`必要な証拠の意味だけを保存する: ${source} ${'type' in row ? row.type : row.method}`, () => {
  const record = { source, row, id: 'proof', at: 1, observedAt: 1, runId: 'run', turnId: 'turn' } as NativeRecord;
  const captured = captureNativeRecord(source, row as never);
  assert.ok(captured);
  assert.deepEqual(readNativeEvidence({ ...record, row: captured }), readNativeEvidence(record));
  assert.equal(JSON.stringify(captured).includes('secret'), false);
});

test('ローカル command は開始にせず、子の通知は本文と出力を複製しない', () => {
  assert.equal(captureNativeRecord('claude', { type: 'user', message: { content: '<command-name>/model</command-name><command-args>secret</command-args>' } }), undefined);
  const row = captureNativeRecord('claude', { type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>child</task-id><summary>secret</summary><status>stopped</status><result>secret</result></task-notification>' });
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes('secret'), false);
  const evidence = readNativeEvidence({ source: 'claude_child', row, id: 'proof', at: 1, observedAt: 1, runId: 'child', turnId: 'turn', childId: 'child' });
  assert.equal(evidence[0].kind === 'signal' && evidence[0].event, 'child_stopped');
});

test('total_tokens_reminder は信号なしでも uuid と parentUuid を秘匿していない構造として残す', () => {
  const row = { type: 'attachment', uuid: '52698412-ec73-4a2a-81d6-c5550508c376', parentUuid: '4edcf548-e60b-4cd4-b608-0ca8ff71a534', attachment: { type: 'total_tokens_reminder', content: 'secret' } };
  const captured = captureNativeRecord('claude', row)!;
  assert.ok(captured); assert.equal(captured.uuid, row.uuid); assert.equal(captured.parentUuid, row.parentUuid);
  assert.equal(JSON.stringify(captured).includes('secret'), false);
  assert.deepEqual(readNativeEvidence({ source: 'claude', row: captured, id: 'record', at: 1, observedAt: 1, runId: 'run' }), []);
});

for (const kind of ['completed', 'started', 'interacted']) test(`Codex SubAgentActivity ${kind} は一致する子へだけ意味を渡す`, () => {
  const row = { type: 'event_msg', payload: { type: 'item_completed', thread_id: 'parent', turn_id: 'parent-turn', item: { type: 'SubAgentActivity', id: 'activity', kind, agent_thread_id: 'child' } } };
  const captured = captureNativeRecord('codex', row)!;
  const record: NativeRecord = { source: 'codex_child', row: captured, id: 'fact', at: 1, observedAt: 1, runId: 'child-run', childId: 'child', turnId: 'child-turn' };
  const signals = readNativeEvidence(record);
  assert.deepEqual(signals.map(signal => signal.kind === 'signal' && [signal.event, signal.turnId]), kind === 'completed' ? [['complete', 'child-turn']] : kind === 'started' ? [['launched', 'child-turn']] : []);
  assert.deepEqual(readNativeEvidence({ ...record, childId: 'other' }), []);
});

test('P6: 信号のない行には UUID の辺と明示の turn だけを残す', () => {
  assert.equal(captureNativeRecord('claude', { type: 'assistant', uuid: 'root' }), undefined);
  assert.deepEqual(captureNativeRecord('claude', { type: 'attachment', timestamp: '2026-01-01', uuid: 'edge', parentUuid: 'parent', promptId: 'turn',
    attachment: { type: 'total_tokens_reminder', content: 'private' } }), { uuid: 'edge', parentUuid: 'parent', promptId: 'turn' });
  assert.deepEqual(captureNativeRecord('codex', { type: 'turn_context', timestamp: '2026-01-01', payload: { turn_id: 'turn', model: 'model', cwd: '/private' } }),
    { type: 'turn_context', payload: { turn_id: 'turn' } });
  assert.equal(captureNativeRecord('codex', { type: 'turn_context', payload: { model: 'model' } }), undefined);
});
