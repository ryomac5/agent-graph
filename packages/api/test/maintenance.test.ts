import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openLedger } from '../../core/src/ledger/ledger.ts';
import type { JsonValue } from '../../core/src/ledger/facts.ts';
import { rebuild } from '../../core/src/ledger/rebuild.ts';
import { MaintenanceService, bindMaintenanceRequests } from '../src/maintenance/index.ts';
import type { RunnerRequest, RunnerResponse } from '../src/runner-client.ts';
import { startMaintenanceWebSocketServer } from '../src/maintenance/websocket.ts';
import { openObservationService } from '../src/service/index.ts';
import { WebSocket } from 'ws';
const OLD = '2026-01-01T00:00:00Z';
function hash(text: string) { return createHash('sha256').update(text).digest('hex'); }
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-'));
  const blobsPath = join(dir, 'blobs'); mkdirSync(blobsPath);
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path, { storageScope: 'full_diff', redactionRules: { defaults: false } });
  const db = new DatabaseSync(path);
  let resyncs = 0;
  const service = new MaintenanceService({ db, blobsPath, resync: () => { resyncs++; } });
  t.after(() => { db.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  function append(id: string, text: string) {
    const input = { source: 'hook' as const, source_event_id: id, kind: 'artifact.updated' as const, subject: `artifact:${id}` as const, source_ts: OLD, observed_ts: OLD, confidence: 'confirmed' as const, payload: { run_id: 'r', version: 1, diff: text, patch_hash: hash(text) } };
    ledger.append(input); writeFileSync(join(blobsPath, hash(text)), text); rebuild(db); return input;
  }
  return { service, ledger, db, blobsPath, append, resyncs: () => resyncs };
}
function assertAbsent(db: DatabaseSync, path: string, secret: string) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const table = String(row.name);
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()).includes(secret), false, table);
  }
  for (const name of readdirSync(path)) assert.equal(readFileSync(join(path, name), 'utf8').includes(secret), false, name);
}

test('rescan fixes ledger, search and content-addressed blobs for every secret fixture', t => {
  const { service, db, blobsPath, append } = fixture(t);
  const secrets = ['sk-proj-' + 'FixtureNeverIssued'.repeat(4), 'env-fixture-value', 'PRIVATEFIXTUREDATA', 'custom-fixture-value'];
  append('s', `+${secrets[0]}\n+API_TOKEN=${secrets[1]}\n-----BEGIN PRIVATE KEY-----\n${secrets[2]}\n-----END PRIVATE KEY-----\n${secrets[3]}`);
  const preview = service.preview({ kind: 'rescan', rules: { patterns: ['custom-fixture-value'] } });
  assert.equal(preview.facts, 1); assert.equal(preview.blobs, 1);
  assert.deepEqual(service.execute(preview.token, 'rescan'), { facts: 1, blobs: 1 });
  for (const secret of secrets) assertAbsent(db, blobsPath, secret);
  const names = readdirSync(blobsPath);
  assert.equal(names.length, 1);
  assert.equal(names[0], hash(readFileSync(join(blobsPath, names[0]), 'utf8')));
  assert.equal(JSON.parse(String(db.prepare('SELECT payload FROM facts').get()!.payload)).patch_hash, names[0]);
});

test('changed retention timestamps invalidate confirmation before blobs are deleted', t => {
  const f = fixture(t);
  f.append('timestamp', '+timestamp-fixture');
  const preview = f.service.preview({ kind: 'retention', now: '2026-10-07T00:00:00Z' });
  f.db.prepare('UPDATE facts SET observed_ts = ?').run('2026-10-01T00:00:00Z');
  assert.throws(() => f.service.execute(preview.token, 'retention'), /stale/);
  assert.equal(readFileSync(join(f.blobsPath, hash('+timestamp-fixture')), 'utf8'), '+timestamp-fixture');
  assert.ok(JSON.stringify(f.ledger.readSince(0, 1)).includes('timestamp-fixture'));
});

test('invalid redaction rule shapes are rejected by preview commands', async t => {
  const f = fixture(t);
  const invalidRules: JsonValue[] = [null, [], { defaults: 'false' }, { patterns: 'secret' }, { patterns: [{}] }];
  for (const rules of invalidRules) {
    const response = await f.service.handle({ type: 'cmd', cmd_id: JSON.stringify(rules),
      command: 'maintenance.preview', payload: { operation: { kind: 'rescan', rules } } });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Invalid redaction rules');
  }
});

test('retention cmd requires preview and confirmation, removes blobs, and replay never multiplies facts', async t => {
  const f = fixture(t);
  const input = f.append('old', '+expired-fixture');
  const preview = f.service.preview({ kind: 'retention', now: '2026-10-07T00:00:00Z' });
  assert.deepEqual({ facts: preview.facts, blobs: preview.blobs }, { facts: 1, blobs: 1 });
  const message = { type: 'cmd' as const, cmd_id: 'remove', command: 'maintenance.retention', payload: { token: preview.token, confirmation: true } };
  assert.equal((await f.service.handle({ ...message, payload: { token: preview.token } })).ok, false);
  const result = await f.service.handle(message);
  assert.equal(result.ok, true);
  assert.deepEqual(await f.service.handle(message), result);
  assert.equal(f.resyncs(), 1);
  assertAbsent(f.db, f.blobsPath, 'expired-fixture');
  assert.equal(readdirSync(f.blobsPath).length, 0);
  assert.equal(f.ledger.append(input).status, 'duplicate');
  assert.equal(f.ledger.readSince(0, 10).length, 1);
});

test('narrowed scope counts before deletion and removes existing diff blobs', t => {
  const f = fixture(t); f.append('scope', '+outside-scope');
  const preview = f.service.preview({ kind: 'scope', scope: 'tool_output' });
  assert.equal(preview.facts, 1); assert.equal(preview.blobs, 1);
  assert.ok(JSON.stringify(f.ledger.readSince(0, 10)).includes('outside-scope'));
  f.service.execute(preview.token, 'scope');
  assertAbsent(f.db, f.blobsPath, 'outside-scope');
});

test('port routes maintenance locally and forwards other commands; changed targets invalidate preview', async t => {
  const f = fixture(t); f.append('one', '+one');
  const original = async (request: RunnerRequest): Promise<RunnerResponse> => ({ type: 'res', cmd_id: request.cmd_id, ok: false, error: 'forwarded' });
  const port = { request: original };
  const detach = bindMaintenanceRequests(port, f.service);
  const result = await port.request({ type: 'req', cmd_id: 'preview', command: 'maintenance.preview', payload: { operation: { kind: 'scope', scope: 'metadata' } } });
  assert.equal(result.ok, true);
  assert.equal((await port.request({ type: 'req', cmd_id: 'other', command: 'run.start' })).ok, false);
  const preview = f.service.preview({ kind: 'scope', scope: 'metadata' });
  f.append('two', '+two');
  assert.throws(() => f.service.execute(preview.token, 'scope'), /stale/);
  assert.equal(readdirSync(f.blobsPath).length, 2);
  detach(); assert.equal(port.request, original);
});

test('retention also removes expired blob references whose fact stores only metadata', t => {
  const f = fixture(t);
  const body = '+metadata-reference-fixture';
  const name = hash(body);
  f.ledger.append({ source: 'hook', source_event_id: 'reference', kind: 'artifact.updated', subject: 'artifact:reference', source_ts: OLD, observed_ts: OLD, confidence: 'confirmed', payload: { patch_hash: name } });
  writeFileSync(join(f.blobsPath, name), body);
  const preview = f.service.preview({ kind: 'retention', now: '2026-10-07T00:00:00Z' });
  assert.equal(preview.facts, 0); assert.equal(preview.blobs, 1);
  f.service.execute(preview.token, 'retention');
  assert.equal(readdirSync(f.blobsPath).length, 0);
  assert.equal((f.ledger.readSince(0, 1)[0].payload as { patch_hash?: string })?.patch_hash, name);
});

test('invalid rules and changed blob contents leave existing data untouched', async t => {
  const f = fixture(t); f.append('safe', '+safe-fixture');
  assert.throws(() => f.service.preview({ kind: 'rescan', rules: { patterns: ['['] } }), TypeError);
  const preview = f.service.preview({ kind: 'scope', scope: 'metadata' });
  writeFileSync(join(f.blobsPath, hash('+safe-fixture')), '+changed-fixture');
  assert.throws(() => f.service.execute(preview.token, 'scope'), /stale/);
  assert.ok(JSON.stringify(f.ledger.readSince(0, 10)).includes('safe-fixture'));
  const unknown = await f.service.handle({ type: 'cmd', cmd_id: 'unknown', command: 'maintenance.unknown', payload: {} });
  assert.equal(unknown.ok, false);
});

test('retention keeps a shared blob until every referencing fact expires', t => {
  const f = fixture(t);
  const input = f.append('old-shared', '+shared-diff');
  const recent = { ...input, source_event_id: 'recent-shared', subject: 'artifact:recent-shared' as const,
    observed_ts: '2026-10-01T00:00:00Z' };
  f.ledger.append(recent);
  const preview = f.service.preview({ kind: 'retention', now: '2026-10-07T00:00:00Z' });
  assert.equal(preview.facts, 1);
  assert.equal(preview.blobs, 0);
  f.service.execute(preview.token, 'retention');
  assert.equal(readFileSync(join(f.blobsPath, hash('+shared-diff')), 'utf8'), '+shared-diff');
  assert.equal(f.ledger.readSince(0, 10)[0].payload, null);
  assert.equal(f.ledger.append(input).status, 'duplicate');
  const later = f.service.preview({ kind: 'retention', now: '2027-10-07T00:00:00Z' });
  assert.equal(later.facts, 1);
  assert.equal(later.blobs, 1);
  f.service.execute(later.token, 'retention');
  assertAbsent(f.db, f.blobsPath, 'shared-diff');
  assert.equal(f.ledger.append(recent).status, 'duplicate');
});

test('rescan updates blob-only references and is idempotent after replacing content hashes', t => {
  const f = fixture(t);
  const secret = 'blob-only-fixture-secret';
  const body = `+${secret}`;
  const name = hash(body);
  f.ledger.append({ source: 'hook', source_event_id: 'blob-only', kind: 'artifact.updated',
    subject: 'artifact:blob-only', source_ts: OLD, observed_ts: OLD, confidence: 'confirmed',
    payload: { patch_hash: name } });
  writeFileSync(join(f.blobsPath, name), body);
  const operation = { kind: 'rescan', rules: { patterns: [secret] } } as const;
  const preview = f.service.preview(operation);
  assert.equal(preview.facts, 1);
  assert.equal(preview.blobs, 1);
  f.service.execute(preview.token, 'rescan');
  assertAbsent(f.db, f.blobsPath, secret);
  const payload = f.ledger.readSince(0, 1)[0].payload as { patch_hash: string };
  assert.equal(hash(readFileSync(join(f.blobsPath, payload.patch_hash), 'utf8')), payload.patch_hash);
  const again = f.service.preview(operation);
  assert.equal(again.facts, 0);
  assert.equal(again.blobs, 0);
});

test('invalid preview commands return a useful error without changing stored data', async t => {
  const f = fixture(t);
  f.append('invalid-preview', '+unchanged-fixture');
  const result = await f.service.handle({ type: 'cmd', cmd_id: 'invalid-preview',
    command: 'maintenance.preview', payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Invalid maintenance operation');
  assert.equal(readdirSync(f.blobsPath).length, 1);
  assert.ok(JSON.stringify(f.ledger.readSince(0, 1)).includes('unchanged-fixture'));
});

test('projection failure leaves diff blobs intact and the same preview can be retried', t => {
  const f = fixture(t);
  const text = '+retryable-secret';
  f.append('retry', text);
  const preview = f.service.preview({ kind: 'rescan', rules: { patterns: ['retryable-secret'] } });
  f.db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON artifacts BEGIN SELECT RAISE(ABORT, 'projection failed'); END");
  assert.throws(() => f.service.execute(preview.token, 'rescan'), /projection failed/);
  assert.equal(readFileSync(join(f.blobsPath, hash(text)), 'utf8'), text);
  assert.ok(JSON.stringify(f.ledger.readSince(0, 1)).includes('retryable-secret'));
  f.db.exec('DROP TRIGGER fail_artifact');
  assert.deepEqual(f.service.execute(preview.token, 'rescan'), { facts: 1, blobs: 1 });
  assertAbsent(f.db, f.blobsPath, 'retryable-secret');
});

for (const kind of ['retention', 'rescan'] as const) {
  test(`${kind} restores all blobs and database changes after a partial filesystem failure`, t => {
    const f = fixture(t);
    f.append('first', '+first-rollback-secret');
    f.append('second', '+second-rollback-secret');
    const before = readdirSync(f.blobsPath).sort().map(name => [name, readFileSync(join(f.blobsPath, name), 'utf8')]);
    const facts = f.ledger.readSince(0, 10);
    const state = f.db.prepare('SELECT * FROM projection_state').all();
    const preview = f.service.preview(kind === 'retention'
      ? { kind, now: '2026-10-07T00:00:00Z' }
      : { kind, rules: { patterns: ['rollback-secret'] } });
    const unlink = fs.unlinkSync;
    let deletions = 0;
    t.mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
      if (!String(path).endsWith('.tmp') && ++deletions === 2) throw new Error('Injected blob deletion failure');
      unlink(path);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.service.execute(preview.token, kind), /Injected blob deletion failure/);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(readdirSync(f.blobsPath).sort().map(name => [name, readFileSync(join(f.blobsPath, name), 'utf8')]), before);
    assert.deepEqual(f.ledger.readSince(0, 10), facts);
    assert.deepEqual(f.db.prepare('SELECT * FROM projection_state').all(), state);
    assert.equal(f.resyncs(), 0);
    assert.deepEqual(f.service.execute(preview.token, kind), { facts: 2, blobs: 2 });
    assertAbsent(f.db, f.blobsPath, 'rollback-secret');
  });
}

test('Settings commands work over authenticated WebSocket without runner and rebuild triggers resync', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.append('websocket', '+websocket-secret');
  const dbPath = String(f.db.prepare('PRAGMA database_list').get()!.file);
  const observation = openObservationService({ dbPath, readerOnly: true });
  t.after(() => observation.close());
  let api;
  try {
    api = await startMaintenanceWebSocketServer(observation, {
      port: 0, blobsPath: f.blobsPath, runnerPath: join(f.blobsPath, 'absent.sock'),
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EPERM'
      && 'syscall' in error && error.syscall === 'listen')) throw error;
    t.skip('sandbox blocks local TCP socket listen');
    return;
  }
  t.after(() => api.close());
  const socket = new WebSocket(`${api.wsUrl}?token=${api.token}`, { origin: api.url });
  t.after(() => socket.terminate());
  const queue: Record<string, any>[] = [];
  const waiters: ((message: Record<string, any>) => void)[] = [];
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    const resolve = waiters.shift();
    if (resolve) resolve(message); else queue.push(message);
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()!)
    : new Promise<Record<string, any>>(resolve => waiters.push(resolve));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const snapshot = await (await fetch(`${api.url}/snapshot`, { headers: { 'x-agent-graph-token': api.token } })).json();
  socket.send(JSON.stringify({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation }));
  socket.send(JSON.stringify({ type: 'cmd', cmd_id: 'preview-ws', command: 'maintenance.preview',
    payload: { operation: { kind: 'rescan', rules: { patterns: ['websocket-secret'] } } } }));
  const preview = await next();
  assert.equal(preview.type, 'ack');
  assert.equal(preview.ok, true);
  assert.equal(preview.result.facts, 1);
  assert.equal(preview.result.blobs, 1);
  socket.send(JSON.stringify({ type: 'cmd', cmd_id: 'execute-ws', command: 'maintenance.rescan',
    payload: { token: preview.result.token, confirmation: true } }));
  const ack = await next();
  assert.equal(ack.type, 'ack');
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.result, { facts: 1, blobs: 1 });
  assert.equal((await next()).type, 'resync');
  assertAbsent(f.db, f.blobsPath, 'websocket-secret');
  const updated = await (await fetch(`${api.url}/snapshot`, { headers: { 'x-agent-graph-token': api.token } })).json();
  assert.ok(updated.generation > snapshot.generation);
  assert.equal(updated.seq, snapshot.seq);
});
