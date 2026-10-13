import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Worker } from 'node:worker_threads';
import { openLedger, readLedgerDatabase, applyIncremental } from '../../core/src/ledger/index.ts';
import { hasNormalizedLedgerTimestamps } from '../../core/src/ledger/normalize-timestamps.ts';

const UTC = '2026-10-13T00:00:00.000Z';
const OFFSET = '2026-10-13T09:00:00+0900';

function createFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'timestamp-repair-'));
  const path = join(root, 'ledger.db');
  const ledger = openLedger(path);
  ledger.append({ source: 'ui', source_event_id: 'run', source_ts: UTC, confidence: 'confirmed',
    kind: 'run.created', subject: 'run:r', payload: { conversation_id: 'c', generation: 1, state: 'idle', started_ts: 'garbage' } });
  const db = readLedgerDatabase(ledger);
  applyIncremental(db, 0);
  db.prepare('UPDATE facts SET source_ts = ?').run(OFFSET);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, db };
}

async function waitForMessage(worker: Worker, type: string): Promise<Record<string, unknown>> {
  for (;;) {
    const [message] = await once(worker, 'message');
    if (message.type === type) return message;
  }
}

async function startWorker(t: TestContext, root: string, dbPath: string) {
  const worker = new Worker(new URL('../src/service/observation-worker.ts', import.meta.url), {
    workerData: { dbPath, home: root, env: { HOME: root }, observe: false, hook: false }, execArgv: [],
  });
  t.after(async () => { await worker.terminate(); });
  await waitForMessage(worker, 'ready');
  return worker;
}

async function stopWorker(worker: Worker) {
  const exit = once(worker, 'exit');
  worker.postMessage('stop');
  assert.deepEqual(await exit, [0]);
}

test('worker は補完前に ready を返し、配信開始後に一度だけ補完する（観測無効でも実行）', { timeout: 10_000 }, async t => {
  const { root, path, db } = createFixture(t);
  const worker = await startWorker(t, root, path);
  assert.equal(hasNormalizedLedgerTimestamps(db), false);
  const reader = new DatabaseSync(path, { readOnly: true });
  t.after(() => reader.close());
  // 他の書き手がロックを持つ間も、親スレッドは既存の投影を読める。
  db.exec('BEGIN IMMEDIATE');
  try {
    const repaired = waitForMessage(worker, 'timestamps-repaired');
    worker.postMessage('start');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(reader.prepare('SELECT source_ts FROM facts').get()!.source_ts, OFFSET);
    assert.equal(reader.prepare('SELECT started_ts FROM runs').get()!.started_ts, 'garbage');
    db.exec('COMMIT');
    const result = await repaired;
    assert.deepEqual(result.changes, { facts: 1 });
    assert.equal(reader.prepare('SELECT source_ts FROM facts').get()!.source_ts, UTC);
    assert.equal(hasNormalizedLedgerTimestamps(reader), true);
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
  }
  await stopWorker(worker);
  db.prepare('UPDATE facts SET source_ts = ?').run(OFFSET);
  const second = await startWorker(t, root, path);
  const skipped = waitForMessage(second, 'timestamps-repaired');
  second.postMessage('start');
  assert.deepEqual((await skipped).changes, {});
  assert.equal(reader.prepare('SELECT source_ts FROM facts').get()!.source_ts, OFFSET);
  await stopWorker(second);
});

test('補完失敗は台帳と完了印を rollback し、worker の append と投影は続き、次回起動で再試行する', { timeout: 10_000 }, async t => {
  const { root, path, db } = createFixture(t);
  db.exec("CREATE TRIGGER reject_repair BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const worker = await startWorker(t, root, path);
  const failed = waitForMessage(worker, 'timestamp-repair-failed');
  worker.postMessage('start');
  assert.match(String((await failed).message), /injected failure/);
  assert.equal(hasNormalizedLedgerTimestamps(db), false);
  assert.equal(db.prepare('SELECT source_ts FROM facts').get()!.source_ts, OFFSET);
  const appended = waitForMessage(worker, 'append-result');
  const projected = waitForMessage(worker, 'projected');
  worker.postMessage({ type: 'append', id: 1, input: { source: 'ui', source_event_id: 'later', source_ts: '2026-10-13T00:00:01Z',
    confidence: 'confirmed', kind: 'run.updated', subject: 'run:r', payload: { generation: 1, model: 'later' } } });
  assert.equal(((await appended).result as { status: string }).status, 'appended');
  await projected;
  assert.equal(db.prepare('SELECT model FROM runs').get()!.model, 'later');
  await stopWorker(worker);
  db.exec('DROP TRIGGER reject_repair');
  const retry = await startWorker(t, root, path);
  const repaired = waitForMessage(retry, 'timestamps-repaired');
  retry.postMessage('start');
  assert.deepEqual((await repaired).changes, { facts: 1 });
  assert.equal(hasNormalizedLedgerTimestamps(db), true);
  await stopWorker(retry);
});
