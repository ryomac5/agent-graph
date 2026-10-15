import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { openLedger, readLedgerDatabase, applyIncremental, rebuild } from '../packages/core/src/ledger/index.ts';
import { projectRuns } from '../packages/core/src/ledger/projections/runs.ts';

const [path, runId] = process.argv.slice(2);
if (!path || !runId) throw new Error('Usage: node scripts/verify-session-end.mjs <database> <run-id>');
const source = new DatabaseSync(path, { readOnly: true });
source.exec('PRAGMA query_only = ON');
const started = performance.now();
let facts;
let stored;
try {
  // 本番では索引で対象 subject だけを読み、本文を出力・保存しない。
  facts = source.prepare('SELECT * FROM facts WHERE subject = ? ORDER BY seq').all(`run:${runId}`)
    .map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }));
  const row = source.prepare("SELECT data FROM projection_records WHERE projection = 'runs' AND entity_id = ?").get(runId);
  assert.ok(row, 'Stored projection is required');
  stored = JSON.parse(row.data);
} finally { source.close(); }
assert.ok(facts.length);
const projected = projectRuns(facts).find(run => run.id === runId);
assert.ok(projected && ['running', 'idle'].includes(projected.state));
assert.equal(projected.ended_ts, undefined);
assert.equal(projected.end_evidence, undefined);
const replayMs = performance.now() - started;

const ledger = openLedger(':memory:', { storageScope: 'full_diff' });
try {
  const db = readLedgerDatabase(ledger);
  for (const fact of facts) ledger.append(fact);
  const state = applyIncremental(db, 0);
  // 旧い本番投影をメモリ DB に置き、全履歴を保持したまま次の事実を追記する。
  const columns = db.prepare('PRAGMA table_info(runs)').all().map(row => row.name);
  const values = columns.map(column => {
    const value = stored[column];
    return value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : value;
  });
  db.prepare(`INSERT OR REPLACE INTO runs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
  db.prepare("UPDATE projection_records SET data = ? WHERE projection = 'runs' AND entity_id = ?")
    .run(JSON.stringify(stored), runId);
  const timestamp = new Date(Math.max(...facts.map(fact => Date.parse(fact.source_ts))) + 1).toISOString();
  ledger.append({ source: 'hook', source_event_id: 'verification-next-fact', kind: 'run.updated', subject: `run:${runId}`,
    source_ts: timestamp, confidence: 'confirmed', payload: { conversation_id: stored.conversation_id, generation: stored.generation } });
  const incrementalStarted = performance.now();
  const next = applyIncremental(db, state.last_seq);
  const incrementalMs = performance.now() - incrementalStarted;
  const read = () => JSON.parse(db.prepare("SELECT data FROM projection_records WHERE projection = 'runs' AND entity_id = ?").get(runId).data);
  assert.deepEqual(read(), projected);
  assert.equal(next.generation, state.generation);
  rebuild(db);
  assert.deepEqual(read(), projected);
  console.log(JSON.stringify({ run_id: runId, facts: facts.length, stored: stored.state, replay: projected.state,
    incremental: projected.state, generation_unchanged: true, rebuild_matches: true,
    last_evidence_ts: projected.last_evidence_ts, replay_ms: Math.round(replayMs), incremental_ms: Math.round(incrementalMs) }, null, 2));
} finally { ledger.close(); }
