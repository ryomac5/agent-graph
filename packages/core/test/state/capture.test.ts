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
