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

const { assessReplayMetrics, checkReplay, replayExitCode, restoreLegacyE2, measureAppendRefresh,
  MAX_APPEND_REFRESH_MS, MAX_EVALUATED_HEAP_BYTES, MAX_MISSING_TURN_RATIO } = await import('./prod-replay.mjs');
const coverage = { claude: { runs: 100, missing: 1, ratio: MAX_MISSING_TURN_RATIO }, codex: { runs: 100, missing: 0, ratio: 0 } };
const metrics = { appendRefreshMs: MAX_APPEND_REFRESH_MS, heapBytes: MAX_EVALUATED_HEAP_BYTES, coverage };
test('performance gates accept the boundary and reject the observed 3.3 seconds and 1 GiB', () => {
  assert.equal(replayExitCode(assessReplayMetrics(metrics)), 0);
  for (const patch of [{ appendRefreshMs: 3300 }, { heapBytes: 1024 ** 3 }, { appendRefreshMs: NaN },
    { coverage: { ...coverage, codex: { runs: 100, missing: 2, ratio: 0.02 } } }]) {
    assert.equal(replayExitCode(assessReplayMetrics({ ...metrics, ...patch })), 1);
  }
  const noGc = assessReplayMetrics({ ...metrics, heapBytes: undefined });
  assert.equal(noGc[1].status, 'unavailable'); assert.match(noGc[1].reason, /--expose-gc/);
});

test('missing historical IDs are unavailable and no busy sessions are skipped with reasons', () => {
  for (const name of ['E1', 'E2', 'E3']) {
    const result = checkReplay(name, () => assert.fail('absent fixture was evaluated'), { present: false, reason: 'source IDs removed' });
    assert.equal(result.status, 'unavailable'); assert.equal(result.ok, null); assert.ok(result.reason);
    assert.equal(replayExitCode([result]), 2);
  }
  const busy = checkReplay('busy', () => assert.fail('no busy session was evaluated'), { present: false, absent: 'skip', reason: 'No live busy sessions' });
  assert.equal(busy.status, 'skip'); assert.ok(busy.reason); assert.equal(replayExitCode([busy]), 0);
  assert.equal(replayExitCode([busy, checkReplay('mismatch', () => assert.fail('wrong state'))]), 1);
});

test('missing E2 source rows do not partially restore historical watches or throw', t => {
  const directory = mkdtempSync(join(tmpdir(), 'replay-e2-missing-')); const path = join(directory, 'db');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE api_send_watches (id TEXT); CREATE TABLE facts (seq INTEGER, kind TEXT, payload TEXT)');
  assert.equal(restoreLegacyE2(path), 'unavailable');
  assert.equal(db.prepare('SELECT count(*) AS n FROM api_send_watches').get().n, 0); db.close();
});

test('refresh probe appends exactly one fact to the largest existing history on the copy', async t => {
  const { openLedger } = await import('../../packages/core/src/ledger/index.ts');
  const { openObservationService } = await import('../../packages/api/src/service/index.ts');
  const { ProjectionFeed } = await import('../../packages/api/src/service/projection-feed.ts');
  const directory = mkdtempSync(join(tmpdir(), 'replay-probe-')); const path = join(directory, 'db');
  const ledger = openLedger(path);
  const service = openObservationService({ dbPath: path, home: directory, env: { HOME: directory } });
  const feed = new ProjectionFeed(path, service.catchUp);
  t.after(() => { feed.close(); service.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  for (const name of ['small', 'large']) {
    const base = { source: 'hook', source_ts: at, confidence: 'confirmed' };
    ledger.append({ ...base, source_event_id: name, kind: 'conversation.created', subject: `conversation:${name}`, payload: { provider: 'claude', native_id: name } });
    ledger.append({ ...base, source_event_id: `${name}:run`, kind: 'run.created', subject: `run:${name}`, payload: { conversation_id: name, generation: 1, started_ts: at } });
    for (let i = 0; i < (name === 'large' ? 5 : 1); i++) ledger.append({ ...base, source_event_id: `${name}:${i}`, kind: 'run.updated', subject: `run:${name}`, payload: { conversation_id: name, generation: 1 } });
  }
  feed.refresh(Date.parse(at));
  const before = ledger.readSince(0, 100).length;
  const probe = measureAppendRefresh(path, feed, Date.parse(at));
  assert.equal(probe.subject, 'run:large'); assert.ok(Number.isFinite(probe.elapsedMs));
  assert.equal(ledger.readSince(0, 100).length, before + 1);
  assert.equal(feed.snapshot().seq, ledger.readSince(0, 100).at(-1).seq);
});
