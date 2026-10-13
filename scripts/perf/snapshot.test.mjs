import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createReadOnlyFeed, describeSnapshot } from './snapshot.mjs';
import { createCompactSnapshotFeed } from '../../packages/api/test/fixtures/compact-snapshot.ts';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';

test('読み取り専用の測定は通常の feed と同じ snapshot を作り、書き込まない', t => {
  const directory = mkdtempSync(join(tmpdir(), 'measure-snapshot-'));
  const path = join(directory, 'ledger.db');
  const f = createCompactSnapshotFeed(path);
  const db = new DatabaseSync(path, { readOnly: true });
  t.after(() => { db.close(); f.close(); rmSync(directory, { recursive: true }); });
  db.exec('BEGIN');
  const feed = createReadOnlyFeed(ProjectionFeed, db);
  assert.deepEqual(feed.snapshot(), f.feed.snapshot());
  assert.equal(db.prepare('SELECT total_changes() AS changes').get().changes, 0);
  assert.throws(() => db.exec('DELETE FROM facts'), /readonly/);
  db.exec('ROLLBACK');
});

test('byte の欄別内訳は UTF-8 のキーと値を数え、構造の区切りを含めて表全体と一致する', () => {
  const rows = [{ id: 'one', text: '日本語', optional: null }, { id: 'two', text: 'line\n"quoted"', items: [1, 2] }];
  const snapshot = { seq: 1, generation: 0, projection: { examples: rows }, identities: { conversations: {}, runs: {} } };
  const report = describeSnapshot(snapshot);
  const table = report.tables.examples;
  const punctuation = 2 + rows.length - 1 + rows.reduce((sum, row) => sum + 2 + Object.keys(row).length - 1, 0);
  assert.equal(table.bytes, Object.values(table.fields).reduce((sum, field) => sum + field.bytes, 0) + punctuation);
  assert.equal(report.bytes, Buffer.byteLength(JSON.stringify(snapshot)));
  assert.equal(table.fields.text.count, 2);
});
