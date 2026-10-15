import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyProductionDatabase, replayProduction } from './prod-replay.mjs';

test('VACUUM INTO includes committed WAL rows and never changes the source database or WAL', t => {
  const directory = mkdtempSync(join(tmpdir(), 'replay-copy-test-'));
  const sourcePath = join(directory, 'source.db'), destination = join(directory, 'copy.db');
  const source = new DatabaseSync(sourcePath);
  t.after(() => { source.close(); rmSync(directory, { recursive: true, force: true }); });
  source.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe (id INTEGER); INSERT INTO probe VALUES (1)');
  const before = readFileSync(sourcePath), wal = readFileSync(sourcePath + '-wal');
  copyProductionDatabase(sourcePath, destination);
  const copy = new DatabaseSync(destination);
  assert.equal(copy.prepare('SELECT id FROM probe').get().id, 1);
  copy.exec('INSERT INTO probe VALUES (2)'); copy.close();
  assert.deepEqual(readFileSync(sourcePath), before); assert.deepEqual(readFileSync(sourcePath + '-wal'), wal);
  assert.equal(source.prepare('SELECT count(*) AS n FROM probe').get().n, 1);
});

test('an unreadable source is reported as unverified with exit code 2 and environment restored', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'replay-failure-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stateHome = process.env.XDG_STATE_HOME;
  const result = await replayProduction({ db: join(directory, 'missing.db') });
  assert.equal(result.exitCode, 2); assert.ok(result.error); assert.equal(process.env.XDG_STATE_HOME, stateHome);
});
