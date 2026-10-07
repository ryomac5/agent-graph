import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openLedger, type StorageScope } from '../../src/ledger/ledger.ts';
import type { FactInput } from '../../src/ledger/facts.ts';
import { rebuild, applyIncremental } from '../../src/ledger/rebuild.ts';
import { initializeSearch, searchLedger, SEARCH_KINDS } from '../../src/ledger/search.ts';

function createFixture(t: TestContext, storageScope: StorageScope = 'full_diff') {
  const dir = mkdtempSync(join(tmpdir(), 'search-'));
  const path = join(dir, 'ledger.db');
  const ledger = openLedger(path, { storageScope });
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); ledger.close(); rmSync(dir, { recursive: true }); });
  let event = 0;
  const append = (kind: string, subject: string, payload: object, extra: object = {}) => ledger.append({
    source: 'host-codex', source_event_id: `e${++event}`, source_ts: '2026-01-01T00:00:00Z',
    observed_ts: '2026-01-01T00:00:00Z', confidence: 'confirmed', kind, subject, payload, ...extra,
  } as FactInput);
  const seed = () => {
    append('task.created', 'task:t', { name: 'needle task', purpose: 'work', project: 'repo', state: 'running' });
    append('conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c', task_id: 't', origin: 'managed', type: 'interactive', history_format: 'jsonl' });
    append('run.created', 'run:r', { conversation_id: '["codex","c"]', generation: 1, state: 'running', repository_id: 'repo' });
    append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant', body_state: 'stored', version: 1,
      body: [{ type: 'text', text: 'needle message' }, { type: 'tool_result', content: 'needle embedded' }], tool_output: 'needle output', run_id: 'r' });
    append('message_membership.created', 'message_membership:mm', { message_id: 'm', conversation_id: 'c', active: true });
    append('artifact.version_created', 'artifact:a', { run_id: 'r', version: 1, repository_id: 'repo', worktree_id: 'w', base_sha: 'base', head_sha: 'head', patch_hash: 'hash', untracked: [], diff: '+needle diff' });
    append('finding.created', 'finding:f', { artifact_id: 'a', version: 1, file: 'a.ts', start_line: 1, end_line: 1, side: 'new', context_hash: 'hash', body: 'needle finding', severity: 'warning', state: 'open' });
    append('alias.created', 'alias:a', { entity_id: 't', kind: 'kit', name: 'needle kit-0042' });
  };
  return { ledger, db, path, append, seed };
}

test('FTS5 searches Japanese substrings for every kind and supplements short queries', t => {
  const f = createFixture(t); f.seed();
  f.db.exec(`UPDATE facts SET payload = CASE
    WHEN kind = 'message.created' THEN json_set(payload, '$.body', '横断検索を作るタスクです。', '$.tool_output', '横断検索の道具です。')
    WHEN kind = 'artifact.version_created' THEN json_set(payload, '$.diff', '+横断検索の差分です。')
    WHEN kind = 'finding.created' THEN json_set(payload, '$.body', '横断検索の指摘です。')
    WHEN kind IN ('task.created', 'alias.created') THEN json_set(payload, '$.name', '横断検索の名前です。')
    ELSE payload END`);
  rebuild(f.db);
  const result = searchLedger(f.db, { query: '横断検索' });
  assert.equal(result.mode, 'fts5');
  assert.equal(result.total, SEARCH_KINDS.length);
  assert.deepEqual(result.results.map(row => row.kind).sort(), [...SEARCH_KINDS].sort());
  for (const query of ['タスク', '作る', '横', '。']) {
    const response = searchLedger(f.db, { query, kind: 'message' });
    assert.equal(response.mode, 'fts5');
    assert.equal(response.total, 1, query);
  }
  assert.equal(searchLedger(f.db, { query: '不存在' }).total, 0);
  f.ledger.purgePayloads('2026-02-01');
  assert.equal(searchLedger(f.db, { query: '横断検索' }).total, 0);
  assert.equal(searchLedger(f.db, { query: '横' }).total, 0);
});

test('startup replaces an existing unicode61 index with a Japanese-searchable index', t => {
  const f = createFixture(t);
  f.append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant',
    version: 1, body: '横断検索を作るタスクです。', body_state: 'stored' });
  rebuild(f.db);
  f.db.exec(`DROP TRIGGER search_fts_insert; DROP TRIGGER search_fts_update; DROP TRIGGER search_fts_delete;
    DROP TABLE search_fts;
    CREATE VIRTUAL TABLE search_fts USING fts5(id UNINDEXED, body, identifiers, tokenize='unicode61');
    INSERT INTO search_fts(rowid, id, body, identifiers) SELECT rowid, id, body, identifiers FROM search_documents;`);
  assert.equal(searchLedger(f.db, { query: '横断検索' }).total, 0);
  const ledger = openLedger(f.path);
  ledger.close();
  assert.equal(searchLedger(f.db, { query: '横断検索' }).total, 1);
  assert.equal(searchLedger(f.db, { query: 'タスク' }).total, 1);
  f.ledger.purgePayloads('2026-02-01');
  assert.equal(searchLedger(f.db, { query: '横断検索' }).total, 0);
});

test('incremental search uses context projected by another connection and agrees with rebuild', t => {
  const f = createFixture(t);
  rebuild(f.db);
  const other = new DatabaseSync(f.path);
  t.after(() => other.close());
  f.append('task.created', 'task:t', { name: 'work', project: 'repo', state: 'running' });
  f.append('conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c', task_id: 't',
    origin: 'managed', type: 'interactive', history_format: 'jsonl' });
  applyIncremental(other, 0);
  f.append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant',
    version: 1, body: '横断検索の発言です。', body_state: 'stored' });
  f.append('message_membership.created', 'message_membership:mm', { message_id: 'm', conversation_id: 'c', active: true });
  applyIncremental(f.db, 0);
  const before = searchLedger(f.db, { query: '' });
  const result = searchLedger(f.db, { query: '横断検索', project: 'repo', provider: 'codex', kind: 'message' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].conversation_id, '["codex","c"]');
  assert.equal(result.results[0].project, 'repo');
  rebuild(f.db);
  assert.deepEqual(searchLedger(f.db, { query: '' }), before);
});

test('FTS searches every kind, embedded tool output, aliases and project/provider/period/kind filters', t => {
  const f = createFixture(t); f.seed(); rebuild(f.db);
  const result = searchLedger(f.db, { query: 'needle' });
  assert.equal(result.mode, 'fts5');
  assert.deepEqual([...new Set(result.results.map(row => row.kind))].sort(), [...SEARCH_KINDS].sort());
  assert.equal(result.total, 6);
  const message = result.results.find(row => row.kind === 'message')!;
  assert.equal(message.conversation_id, '["codex","c"]');
  assert.equal(message.message_id, '["codex","m"]');
  assert.equal(message.run_id, 'r');
  assert.equal(message.confidence, 'confirmed');
  assert.ok(!message.body!.includes('embedded'));
  assert.ok(searchLedger(f.db, { query: 'embedded' }).results.every(row => row.kind === 'tool_output'));
  assert.equal(searchLedger(f.db, { query: 'kit-0042' }).results[0].kind, 'alias');
  assert.equal(searchLedger(f.db, { query: 'needle', project: 'repo', provider: 'codex', kind: 'finding', from: '2025-12-31', to: '2026-01-02' }).total, 1);
  for (const filters of [{ project: 'other' }, { provider: 'claude' }, { from: '2027-01-01' }, { to: '2025-01-01' }]) {
    assert.equal(searchLedger(f.db, { query: 'needle', ...filters }).total, 0);
  }
  assert.equal(searchLedger(f.db, { query: 'needle', limit: 2, offset: 2 }).results.length, 2);
  assert.equal(searchLedger(f.db, { query: '" OR *' }).total, 0);
  assert.throws(() => searchLedger(f.db, { query: '', from: 'invalid' }), TypeError);
});

test('incremental and complete rebuild agree, including corrections and late memberships', t => {
  const f = createFixture(t); f.seed();
  const count = f.ledger.readSince(0, 100).length;
  // 1 件ずつ再送しながら投影する別の台帳でも同じ検索結果になる。
  const other = createFixture(t);
  for (const fact of [...f.ledger.readSince(0, 100)].reverse()) {
    other.ledger.append(fact as FactInput); applyIncremental(other.db, 0);
  }
  rebuild(f.db);
  assert.deepEqual(searchLedger(other.db, { query: 'needle' }), searchLedger(f.db, { query: 'needle' }));
  const original = f.ledger.readSince(0, 100).find(row => row.subject === 'message:m')!;
  f.append('message.corrected', 'message:m', { body: 'replacement' }, { supersedes: original.fact_id });
  applyIncremental(f.db, count);
  assert.equal(searchLedger(f.db, { query: 'message' }).results.filter(row => row.kind === 'message' && row.body?.includes('needle')).length, 0);
  assert.equal(searchLedger(f.db, { query: 'replacement' }).total, 1);
  const before = searchLedger(f.db, { query: '' }); rebuild(f.db);
  assert.deepEqual(searchLedger(f.db, { query: '' }), before);
  applyIncremental(f.db, 0);
  assert.deepEqual(searchLedger(f.db, { query: '' }), before);
});

test('retention removes indexed bodies immediately and preserves bodyless metadata through rebuild', t => {
  const f = createFixture(t); f.seed(); rebuild(f.db);
  f.ledger.purgePayloads('2026-02-01');
  assert.equal(searchLedger(f.db, { query: 'needle' }).total, 0);
  const before = searchLedger(f.db, { query: '' });
  assert.equal(before.total, 6);
  assert.ok(before.results.every(row => row.body === null && row.reason === 'retention'));
  assert.equal(searchLedger(f.db, { query: 'message:m' }).results[0].body, null);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM search_fts').all()).includes('needle'));
  rebuild(f.db);
  assert.deepEqual(searchLedger(f.db, { query: '' }), before);
});

test('storage scope and redaction apply before indexing, with unsupported history notices', t => {
  const f = createFixture(t, 'metadata'); f.seed(); rebuild(f.db);
  assert.equal(searchLedger(f.db, { query: 'output' }).total, 0);
  assert.equal(searchLedger(f.db, { query: 'diff', kind: 'diff' }).results.filter(row => row.body !== null).length, 0);
  const redacted = createFixture(t);
  const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz123456';
  redacted.append('message.created', 'message:s', { provider: 'codex', native_id: 's', role: 'assistant', version: 1, body: secret, body_state: 'stored' });
  redacted.append('observation.unsupported', 'observation:o', { source_kind: 'rollout-codex', file_path: '/outside', format_name: 'future', format_version: '99', reason: 'Unknown format version' });
  rebuild(redacted.db);
  assert.equal(searchLedger(redacted.db, { query: secret }).total, 0);
  assert.ok(!JSON.stringify(redacted.db.prepare('SELECT * FROM search_fts').all()).includes(secret));
  assert.equal(searchLedger(redacted.db, { query: '' }).unsupported[0].reason, 'Unknown format version');
});

test('startup detects unavailable FTS5 and substring search treats wildcard characters literally', t => {
  const f = createFixture(t);
  // FTS5 を含まない SQLite の起動時のエラーを再現する。
  f.db.exec('DROP TRIGGER search_fts_insert; DROP TRIGGER search_fts_update; DROP TRIGGER search_fts_delete; DROP TABLE search_fts');
  const exec = f.db.exec.bind(f.db);
  f.db.exec = (sql: string) => { if (sql.includes('USING fts5')) throw new Error('no such module: fts5'); exec(sql); };
  assert.equal(initializeSearch(f.db), 'substring');
  f.append('message.created', 'message:s', { provider: 'codex', native_id: 's', role: 'assistant', version: 1, body: '日本語 needle 100%_test', body_state: 'stored' });
  rebuild(f.db);
  assert.equal(searchLedger(f.db, { query: 'eed' }).total, 1);
  assert.equal(searchLedger(f.db, { query: '本語' }).total, 1);
  assert.equal(searchLedger(f.db, { query: '%_' }).total, 1);
  assert.equal(searchLedger(f.db, { query: '%missing' }).total, 0);
});

test('startup falls back with an existing FTS table and rebuilds it when FTS returns', t => {
  const f = createFixture(t);
  f.append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant',
    version: 1, body: 'old searchable body', body_state: 'stored' });
  rebuild(f.db);
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql: string) => {
    if (sql.includes('SELECT rowid FROM search_fts')) throw new Error('no such module: fts5');
    return prepare(sql);
  };
  assert.equal(initializeSearch(f.db), 'substring');
  assert.equal(searchLedger(f.db, { query: 'searchable' }).mode, 'substring');
  f.ledger.purgePayloads('2026-02-01');
  rebuild(f.db);
  assert.equal(searchLedger(f.db, { query: 'searchable' }).total, 0);
  f.db.prepare = prepare;
  assert.equal(initializeSearch(f.db), 'fts5');
  assert.equal(searchLedger(f.db, { query: 'searchable' }).total, 0);
  assert.equal(searchLedger(f.db, { query: 'message:m' }).results[0].reason, 'retention');
});

test('retention of a body inherited by a newer correction removes its index and survives catch-up', t => {
  const f = createFixture(t);
  const original = f.append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant', version: 1, body: 'inherited sensitive', body_state: 'stored' });
  f.append('message.corrected', 'message:m', { phase: 'final_answer' }, { supersedes: original.fact_id, observed_ts: '2026-03-01T00:00:00Z' });
  rebuild(f.db);
  assert.equal(searchLedger(f.db, { query: 'sensitive' }).total, 1);
  f.ledger.purgePayloads('2026-02-01');
  assert.equal(searchLedger(f.db, { query: 'sensitive' }).total, 0);
  applyIncremental(f.db, 0);
  const after = searchLedger(f.db, { query: '' });
  assert.equal(after.results[0].reason, 'retention');
  rebuild(f.db);
  assert.deepEqual(searchLedger(f.db, { query: '' }), after);
});

test('a re-redacted payload updates the index without a new sequence', t => {
  const f = createFixture(t);
  f.append('message.created', 'message:m', { provider: 'codex', native_id: 'm', role: 'assistant', version: 1, body: 'original', body_state: 'stored' });
  rebuild(f.db);
  f.db.exec(`UPDATE facts SET payload = json_set(payload, '$.body', '[REDACTED:custom:1234]') WHERE subject = 'message:m'`);
  applyIncremental(f.db, 0);
  assert.equal(searchLedger(f.db, { query: 'original' }).total, 0);
  assert.equal(searchLedger(f.db, { query: 'REDACTED' }).total, 1);
});

test('each non-message delta agrees with rebuild, including late context and metadata corrections', t => {
  const f = createFixture(t);
  f.seed();
  const inputs = f.ledger.readSince(0, 100);
  const other = createFixture(t);
  for (const fact of inputs) {
    other.ledger.append(fact as FactInput);
    applyIncremental(other.db, 0);
    const before = other.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
    rebuild(other.db);
    assert.deepEqual(other.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before, fact.kind);
  }
  for (const [kind, subject, payload] of [
    ['task.updated', 'task:t', { project: 'new-repo' }],
    ['conversation.updated', 'conversation:c', { task_id: 'other' }],
    ['run.updated', 'run:r', { conversation_id: 'other-conversation', generation: 1 }],
    ['artifact.updated', 'artifact:a', { run_id: 'other-run', version: 1 }],
    ['alias.updated', 'alias:a', { entity_id: 'r' }],
  ] as const) {
    other.append(kind, subject, payload, { source_ts: '2026-02-01T00:00:00Z' });
    applyIncremental(other.db, 0);
    const before = other.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
    rebuild(other.db);
    assert.deepEqual(other.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before, kind);
  }
});

const PERFORMANCE_MESSAGE_COUNT = 20_000;
const MAX_DELTA_MS = 80;

test('20,000 messages: run and task deltas stay below 80 ms and leave unrelated documents untouched', t => {
  const f = createFixture(t);
  f.seed();
  for (let index = 0; index < PERFORMANCE_MESSAGE_COUNT; index++) {
    f.append('message.created', `message:bulk-${index}`, { provider: 'codex', native_id: `bulk-${index}`,
      role: 'assistant', version: 1, body: 'search performance message', body_state: 'stored', run_id: 'r' });
  }
  rebuild(f.db);
  f.db.exec(`CREATE TEMP TABLE search_writes(subject TEXT);
    CREATE TEMP TRIGGER record_search_update AFTER UPDATE ON search_documents BEGIN
      INSERT INTO search_writes VALUES (NEW.subject); END;
    CREATE TEMP TRIGGER record_search_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_writes VALUES (NEW.subject); END;`);
  for (const [kind, subject, payload] of [
    ['run.state_changed', 'run:r', { state: 'idle', generation: 1 }],
    ['run.created', 'run:new', { conversation_id: 'new', generation: 1, state: 'running' }],
    ['task.updated', 'task:t', { name: 'renamed task' }],
    ['task.created', 'task:new', { name: 'new task', project: 'repo', purpose: 'new', state: 'running' }],
    ['run.updated', 'run:new', { conversation_id: 'updated', generation: 1 }],
    ['task.updated', 'task:new', { project: 'updated-repo' }],
  ] as const) {
    f.append(kind, subject, payload, { source_ts: '2026-02-01T00:00:00Z' });
    const start = performance.now();
    applyIncremental(f.db, 0);
    const elapsed = performance.now() - start;
    t.diagnostic(`${kind}: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < MAX_DELTA_MS, `${kind}: ${elapsed.toFixed(1)} ms exceeds ${MAX_DELTA_MS} ms`);
  }
  assert.ok(f.db.prepare('SELECT subject FROM search_writes').all().every(row => row.subject === 'task:t' || row.subject === 'task:new'));
  const before = f.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
  rebuild(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before);
});


test('reference migration backfills all dependencies for an already indexed ledger', t => {
  const f = createFixture(t); f.seed(); rebuild(f.db);
  f.db.exec(`DROP TRIGGER IF EXISTS search_reference_created; DROP TRIGGER search_reference_deleted;
    DROP TABLE search_references;`);
  initializeSearch(f.db);
  f.append('task.updated', 'task:t', { project: 'migrated-repo' }, { source_ts: '2026-02-01T00:00:00Z' });
  applyIncremental(f.db, 0);
  assert.equal(searchLedger(f.db, { query: 'needle', project: 'migrated-repo' }).total, 6);
  const before = f.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
  rebuild(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before);
});

test('versioned artifact references and shared artifact identities use the same context as rebuild', t => {
  const f = createFixture(t); f.seed(); rebuild(f.db);
  f.append('artifact.version_created', 'artifact:a', { run_id: 'r', version: 2, diff: 'second diff' });
  f.append('finding.created', 'finding:versioned', { artifact_id: 'a@2', version: 2, body: 'versioned finding' });
  applyIncremental(f.db, 0);
  assert.equal(searchLedger(f.db, { query: 'versioned finding' }).results[0].run_id, 'r');
  f.append('artifact.version_created', 'artifact:shared', { run_id: 'r', version: 1, diff: 'shared diff' });
  f.append('finding.created', 'finding:shared', { artifact_id: 'shared', version: 1, body: 'shared finding' });
  applyIncremental(f.db, 0);
  const before = f.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
  rebuild(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before);
});

test('context purged before catch-up still resolves destinations and agrees with rebuild', t => {
  const f = createFixture(t);
  f.append('task.created', 'task:t', { name: 'work', project: 'repo', purpose: 'work', state: 'running' });
  f.append('conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c', task_id: 't',
    origin: 'managed', type: 'interactive', history_format: 'jsonl' });
  rebuild(f.db);
  f.append('run.created', 'run:r', { conversation_id: 'c', generation: 1, state: 'running' });
  f.append('artifact.version_created', 'artifact:a', { run_id: 'r', version: 1, diff: 'purged diff' });
  f.append('finding.created', 'finding:f', { artifact_id: 'a', version: 1, body: 'purged finding' });
  f.ledger.purgePayloads('2026-02-01');
  applyIncremental(f.db, 0);
  const result = searchLedger(f.db, { query: '', kind: 'finding' }).results[0];
  assert.equal(result.conversation_id, '["codex","c"]');
  assert.equal(result.project, 'repo');
  assert.equal(result.reason, 'retention');
  const before = f.db.prepare('SELECT * FROM search_documents ORDER BY id').all();
  rebuild(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM search_documents ORDER BY id').all(), before);
});

test('metadata is extracted during refresh, and rebuild does not rewrite existing references', t => {
  const f = createFixture(t); f.seed();
  assert.equal(f.db.prepare("SELECT count(*) AS count FROM search_sources").get()!.count, 0);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'search_source_created'").get(), undefined);
  rebuild(f.db);
  const before = searchLedger(f.db, { query: '' });
  f.db.exec(`CREATE TEMP TABLE reference_writes(fact_id TEXT);
    CREATE TEMP TRIGGER record_reference_insert AFTER INSERT ON search_references BEGIN
      INSERT INTO reference_writes VALUES (NEW.fact_id); END;`);
  rebuild(f.db);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM reference_writes').get()!.count, 0);
  assert.deepEqual(searchLedger(f.db, { query: '' }), before);
});

test('unsupported history notices are bounded and include the most recent observations', t => {
  const f = createFixture(t);
  for (let index = 0; index < 110; index++) {
    f.append('observation.unsupported', `observation:${index}`, { source_kind: 'rollout-codex',
      file_path: '/outside', format_name: 'future', format_version: '99', reason: 'Unknown format version' });
  }
  const response = searchLedger(f.db, { query: '' });
  assert.equal(response.unsupported.length, 100);
  assert.equal(response.unsupported[0].subject, 'observation:109');
});
