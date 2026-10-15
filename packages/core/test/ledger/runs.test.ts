import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRuns, projectRunHistory } from '../../src/ledger/projections/runs.ts';
import type { Fact } from '../../src/ledger/facts.ts';
const AT = '2026-10-15T00:00:00.000Z';
function fact(id: string, payload: object, kind = 'run.updated', at = AT): Fact {
  return { fact_id: id, source_event_id: id, subject: 'run:r', source: 'hook', kind,
    payload, source_ts: at, observed_ts: at, confidence: 'confirmed', seq: 1, cursor: null, supersedes: null, payload_hash: id, schema_version: 1 } as Fact;
}
const created = fact('created', { conversation_id: 'c', generation: 1, state: 'unknown', started_ts: AT, pid: 41, start_fingerprint: 'A' }, 'run.created');

test('run 投影は台帳の属性を保持し、申告状態の真偽を決めない', () => {
  const declared = fact('declared', { state: 'ended', reason: 'unconfirmed', end_evidence: { kind: 'unrecognized' } }, 'run.state_changed');
  const run = projectRuns([created, declared])[0];
  assert.equal(run.state, 'ended'); assert.equal(run.reason, 'unconfirmed');
  assert.deepEqual(run.end_evidence, { kind: 'unrecognized' });
  assert.deepEqual(projectRuns([declared, created]), [run]);
});

test('現在の turn の時計や終了の判定を投影に書き込まない', () => {
  const start = fact('prompt', { generation: 1, state: 'running', last_evidence: { hook_event_name: 'UserPromptSubmit' } });
  const run = projectRuns([created, start])[0];
  assert.equal(run.turn_started_ts, undefined);
  const native = fact('record', { generation: 1, last_evidence: { native_source: 'claude', native_record: { type: 'assistant' } }, last_evidence_ts: AT });
  assert.deepEqual(projectRuns([created, start, native]), [run]);
});

test('世代ごとに PID を隔離し、訂正と並べ替えで同じ属性を再現する', () => {
  const next = fact('new', { conversation_id: 'c', generation: 2, state: 'unknown', model: 'model-B' }, 'run.created', '2026-10-15T00:01:00Z');
  const correction = { ...fact('corrected', { model: 'model-C', generation: 2 }), source_ts: next.source_ts, supersedes: null };
  const expected = projectRuns([created, next, correction]);
  assert.equal(expected[1].pid, undefined); assert.equal(expected[1].start_fingerprint, undefined);
  assert.deepEqual(projectRuns([correction, next, created]), expected);
  assert.equal(projectRuns([created, { ...fact('cancel', { state: 'idle' }), supersedes: created.fact_id }]).length, 0);
});

test('終了の履歴は新しい申告で消さず、キューの過去の区切りに使える', () => {
  const end = fact('end', { state: 'ended', ended_ts: '2026-10-15T00:01:00Z' }, 'run.ended', '2026-10-15T00:01:00Z');
  const resumed = fact('resume', { state: 'running' }, 'run.state_changed', '2026-10-15T00:02:00Z');
  const history = projectRunHistory([created, end, resumed]);
  assert.equal(history.runs[0].state, 'running');
  assert.equal(history.ends[0].ended_ts, '2026-10-15T00:01:00Z');
});
