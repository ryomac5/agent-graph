import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openLedger } from '../../src/ledger/ledger.ts';
import { rebuild } from '../../src/ledger/rebuild.ts';
import { applyMaintenance, planMaintenance } from '../../src/ledger/retention.ts';
import type { FactInput } from '../../src/ledger/facts.ts';

const OLD = '2026-01-01T00:00:00Z';
const NOW = '2026-10-07T00:00:00Z';
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'retention-'));
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path, { storageScope: 'full_diff', redactionRules: { defaults: false } });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ledger, db, dir };
}
function message(id: string, body: string, observed_ts = OLD): Extract<FactInput, { kind: 'message.updated' }> {
  return { source: 'hook', source_event_id: id, kind: 'message.updated', subject: `message:${id}`,
    source_ts: OLD, observed_ts, confidence: 'confirmed', payload: { body, role: 'user', body_state: 'stored' } };
}
function assertAbsent(db: DatabaseSync, secret: string) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const name = String(row.name);
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()).includes(secret), false, name);
  }
}

test('retention preview preserves metadata and boundary, clears payload and index, and replay stays duplicate', t => {
  const { ledger, db } = fixture(t);
  const expired = message('old', 'expired body');
  ledger.append(expired);
  ledger.append(message('boundary', 'boundary body', '2026-07-09T00:00:00Z'));
  ledger.append({ ...message('meta', ''), kind: 'conversation.updated', subject: 'conversation:meta', payload: { provider: 'claude', native_id: 'meta' } });
  rebuild(db);
  const before = db.prepare('SELECT fact_id, payload_hash, seq FROM facts WHERE source_event_id = ?').get('old');
  const plan = planMaintenance(db, { kind: 'retention', now: NOW });
  assert.equal(plan.changes.length, 1);
  assert.equal((ledger.readSince(0, 1)[0].payload as { body?: string })?.body, 'expired body');
  assert.equal(applyMaintenance(db, plan), 1);
  assert.deepEqual(db.prepare('SELECT fact_id, payload_hash, seq FROM facts WHERE source_event_id = ?').get('old'), before);
  assert.equal(ledger.readSince(0, 1)[0].payload, null);
  assertAbsent(db, 'expired body');
  assert.equal(ledger.append(expired).status, 'duplicate');
  assert.equal(ledger.readSince(0, 10).length, 3);
  assert.equal(planMaintenance(db, { kind: 'retention', now: NOW }).changes.length, 0);
});

test('new facts and changed retention timestamps invalidate the core preview', t => {
  const { ledger, db } = fixture(t);
  ledger.append(message('original', 'original-body'));
  const plan = planMaintenance(db, { kind: 'retention', now: NOW });
  ledger.append(message('added', 'added-body'));
  assert.throws(() => applyMaintenance(db, plan), /stale/);
  assert.ok(JSON.stringify(ledger.readSince(0, 10)).includes('original-body'));
  const next = planMaintenance(db, { kind: 'retention', now: NOW });
  db.prepare('UPDATE facts SET observed_ts = ? WHERE source_event_id = ?').run(NOW, 'original');
  assert.throws(() => applyMaintenance(db, next), /stale/);
  assert.ok(JSON.stringify(ledger.readSince(0, 10)).includes('added-body'));
});

test('rescan masks known keys, env values, private keys, custom rules and diff keys everywhere', t => {
  const { ledger, db } = fixture(t);
  const secrets = ['sk-proj-' + 'FakeOnlyNeverIssued'.repeat(3), 'env-fixture-secret', 'PRIVATEFIXTUREDATA', 'custom-fixture-secret'];
  const text = `${secrets[0]}\nAPI_TOKEN=${secrets[1]}\n-----BEGIN PRIVATE KEY-----\n${secrets[2]}\n-----END PRIVATE KEY-----\n${secrets[3]}`;
  const input = message('secret', text);
  ledger.append(input);
  ledger.append({ ...message('diff', ''), kind: 'artifact.updated', subject: 'artifact:diff', payload: { run_id: 'r', version: 1, diff: `+${text}` } });
  rebuild(db);
  const hashes = db.prepare('SELECT payload_hash FROM facts ORDER BY seq').all();
  const operation = { kind: 'rescan', rules: { patterns: ['custom-fixture-secret'] } } as const;
  const plan = planMaintenance(db, operation);
  assert.equal(plan.changes.length, 2);
  applyMaintenance(db, plan);
  for (const secret of secrets) assertAbsent(db, secret);
  assert.deepEqual(db.prepare('SELECT payload_hash FROM facts ORDER BY seq').all(), hashes);
  assert.equal(ledger.append(input).status, 'duplicate');
  assert.equal(ledger.readSince(0, 10).length, 2);
  assert.equal(planMaintenance(db, operation).changes.length, 0);
});

test('scope preview removes nested tool bodies and diffs while preserving allowed message text', t => {
  const { ledger, db } = fixture(t);
  ledger.append({ ...message('scope', 'allowed'), payload: { role: 'user', body: [{ type: 'text', text: 'allowed' }, { type: 'tool_result', content: 'outside-tool' }], tool_output: 'outside-output' } });
  rebuild(db);
  ledger.append({ ...message('diff-scope', ''), kind: 'artifact.updated', subject: 'artifact:diff-scope', payload: { diff: 'outside-diff' } });
  const plan = planMaintenance(db, { kind: 'scope', scope: 'message_body' });
  assert.equal(plan.changes.length, 2);
  applyMaintenance(db, plan);
  for (const secret of ['outside-tool', 'outside-output', 'outside-diff']) assertAbsent(db, secret);
  assert.ok(JSON.stringify(ledger.readSince(0, 10)).includes('allowed'));
  const meta = planMaintenance(db, { kind: 'scope', scope: 'metadata' });
  applyMaintenance(db, meta);
  assertAbsent(db, 'allowed');
});

test('invalid rules and stale plans do not partially update facts', t => {
  const { ledger, db } = fixture(t);
  ledger.append(message('one', 'first')); ledger.append(message('two', 'second'));
  assert.throws(() => planMaintenance(db, { kind: 'rescan', rules: { patterns: ['['] } }), TypeError);
  assert.throws(() => planMaintenance(db, { kind: 'retention', retentionDays: -1 }), TypeError);
  assert.throws(() => planMaintenance(db, { kind: 'retention', now: 'invalid' }), TypeError);
  const plan = planMaintenance(db, { kind: 'scope', scope: 'metadata' });
  db.prepare('UPDATE facts SET payload = ? WHERE source_event_id = ?').run('{}', 'two');
  assert.throws(() => applyMaintenance(db, plan), /stale/);
  assert.equal((ledger.readSince(0, 1)[0].payload as { body?: string })?.body, 'first');
});

test('zero-day retention expires past bodies but keeps the current timestamp and metadata', t => {
  const { ledger, db } = fixture(t);
  ledger.append(message('past', 'past-body'));
  ledger.append(message('current', 'current-body', NOW));
  ledger.append({ ...message('metadata', ''), kind: 'conversation.updated', subject: 'conversation:metadata',
    payload: { provider: 'codex', native_id: 'metadata' } });
  const preview = planMaintenance(db, { kind: 'retention', retentionDays: 0, now: NOW });
  assert.deepEqual(preview.changes.map(change => change.fact_id), [ledger.readSince(0, 1)[0].fact_id]);
  applyMaintenance(db, preview);
  assertAbsent(db, 'past-body');
  assert.ok(JSON.stringify(ledger.readSince(0, 10)).includes('current-body'));
  assert.notEqual(ledger.readSince(2, 1)[0].payload, null);
});

test('rescan removes matching metadata from retained search sources and reference indexes', t => {
  const { ledger, db } = fixture(t);
  ledger.append({ ...message('identifiers', 'ordinary'), payload: { native_id: 'custom-native-secret', provider: 'codex', body: 'ordinary' } });
  rebuild(db);
  const plan = planMaintenance(db, { kind: 'rescan', rules: { patterns: ['custom-native-secret'] } });
  applyMaintenance(db, plan);
  for (const table of ['facts', 'search_sources', 'search_documents', 'search_references', 'fact_projection_dependencies', 'messages', 'entity_records']) {
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('custom-native-secret'), false, table);
  }
});

test('rescan also masks search metadata left by an earlier payload purge', t => {
  const { ledger, db } = fixture(t);
  const secret = 'purged-native-fixture-secret';
  ledger.append({ ...message('purged', 'expired body'),
    payload: { provider: 'codex', native_id: secret, body: 'expired body' } });
  rebuild(db);
  applyMaintenance(db, planMaintenance(db, { kind: 'retention', now: NOW }));
  assert.equal(ledger.readSince(0, 1)[0].payload, null);
  assert.ok(JSON.stringify(db.prepare('SELECT * FROM search_sources').all()).includes(secret));
  const plan = planMaintenance(db, { kind: 'rescan', rules: { patterns: [secret] } });
  assert.equal(plan.changes.length, 0);
  applyMaintenance(db, plan);
  for (const table of ['search_sources', 'search_documents', 'search_references', 'fact_projection_dependencies']) {
    assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), false, table);
  }
});

test('projection failure rolls back payloads, indexes and generation together', t => {
  const { ledger, db } = fixture(t);
  ledger.append(message('atomic', 'atomic-secret'));
  rebuild(db);
  const state = db.prepare('SELECT * FROM projection_state').all();
  const plan = planMaintenance(db, { kind: 'rescan', rules: { patterns: ['atomic-secret'] } });
  db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'projection failed'); END");
  assert.throws(() => applyMaintenance(db, plan), /projection failed/);
  assert.ok(JSON.stringify(ledger.readSince(0, 1)).includes('atomic-secret'));
  assert.ok(JSON.stringify(db.prepare('SELECT * FROM search_documents').all()).includes('atomic-secret'));
  assert.deepEqual(db.prepare('SELECT * FROM projection_state').all(), state);
  db.exec('DROP TRIGGER fail_projection');
  applyMaintenance(db, plan);
  assertAbsent(db, 'atomic-secret');
});

test('commit failure rolls back payloads, search, generation and applied blobs', t => {
  const { ledger, db } = fixture(t);
  ledger.append(message('commit', 'commit-fixture-secret'));
  rebuild(db);
  const state = db.prepare('SELECT * FROM projection_state').all();
  const plan = planMaintenance(db, { kind: 'rescan', rules: { patterns: ['commit-fixture-secret'] } });
  let blob = 'commit-fixture-secret';
  const connection = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (sql === 'COMMIT') throw new Error('Injected commit failure');
      target.exec(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => applyMaintenance(connection, plan, () => ({
    apply() { blob = '[REDACTED]'; },
    rollback() { blob = 'commit-fixture-secret'; },
  })), /Injected commit failure/);
  assert.equal(blob, 'commit-fixture-secret');
  assert.ok(JSON.stringify(ledger.readSince(0, 1)).includes('commit-fixture-secret'));
  assert.ok(JSON.stringify(db.prepare('SELECT * FROM search_documents').all()).includes('commit-fixture-secret'));
  assert.deepEqual(db.prepare('SELECT * FROM projection_state').all(), state);
});

test('anchored rescan rules rebuild encoded projection dependencies from redacted payloads', t => {
  const { ledger, db } = fixture(t);
  ledger.append({ ...message('anchored', 'ordinary'), payload: { provider: 'codex', native_id: 'anchored-secret', body: 'ordinary' } });
  rebuild(db);
  applyMaintenance(db, planMaintenance(db, { kind: 'rescan', rules: { defaults: false, patterns: ['^anchored-secret$'] } }));
  assertAbsent(db, 'anchored-secret');
});

test('rescan truncates historical WAL pages containing the original secret', t => {
  const { ledger, db, dir } = fixture(t);
  const secret = 'historical-wal-fixture-secret';
  ledger.append(message('wal', secret));
  rebuild(db);
  assert.ok(readdirSync(dir).some(name => readFileSync(join(dir, name)).includes(Buffer.from(secret))));
  applyMaintenance(db, planMaintenance(db, { kind: 'rescan', rules: { patterns: [secret] } }));
  for (const name of readdirSync(dir)) {
    assert.equal(readFileSync(join(dir, name)).includes(Buffer.from(secret)), false, name);
  }
});
