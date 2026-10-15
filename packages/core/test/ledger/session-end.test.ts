import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, applyIncremental, rebuild } from '../../src/ledger/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SessionEnd の申告属性は版を上げず差分反映と rebuild で一致し、現在状態は保存しない', t => {
  const directory = mkdtempSync(join(tmpdir(), 'run-metadata-')); const path = join(directory, 'ledger.db');
  const ledger = openLedger(path); const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  ledger.append({ source: 'hook', source_event_id: 'created', subject: 'run:r', kind: 'run.created', confidence: 'confirmed', source_ts: '2026-10-15T00:00:00Z',
    payload: { conversation_id: 'c', generation: 1, state: 'unknown' } });
  const first = applyIncremental(db, 0);
  ledger.append({ source: 'hook', source_event_id: 'end', subject: 'run:r', kind: 'run.state_changed', confidence: 'confirmed', source_ts: '2026-10-15T00:01:00Z',
    payload: { generation: 1, state: 'ended', end_evidence: { kind: 'session_end', generation: 1 } } });
  const next = applyIncremental(db, first.last_seq);
  assert.equal(next.generation, first.generation);
  const read = () => db.prepare('SELECT * FROM runs').all();
  const metadata = read(); rebuild(db); assert.deepEqual(read(), metadata);
  assert.equal(metadata[0].turn_started_ts, null);
  assert.equal('decision' in metadata[0], false);
});
