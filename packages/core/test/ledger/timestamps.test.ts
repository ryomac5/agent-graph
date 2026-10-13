import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { openLedger, readLedgerDatabase, applyIncremental, rebuild, project, type Fact, type FactInput } from '../../src/ledger/index.ts';
import { normalizeTimestamp } from '../../src/ledger/timestamps.ts';
import { hasNormalizedLedgerTimestamps, normalizeLedgerTimestamps } from '../../src/ledger/normalize-timestamps.ts';
import { searchLedger } from '../../src/ledger/search.ts';
import { projectEntityRecords } from '../../src/ledger/projections/delegations.ts';
import { projectEntities } from '../../src/ledger/projections/relations.ts';

const UTC = '2026-10-13T00:00:00.000Z';
const OFFSET = '2026-10-13T09:00:00+0900';

test('時差のない日時は機械の TZ によらず UTC として解釈する', () => {
  const module = new URL('../../src/ledger/timestamps.ts', import.meta.url).href;
  const values = ['2026-10-13T00:00:00', '2026-10-13 00:00:00.123456', '2026-10-13', '2024-02-29T09:00:00+0900'];
  for (const TZ of ['UTC', 'Asia/Tokyo']) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { normalizeTimestamp } from ${JSON.stringify(module)}; console.log(JSON.stringify(${JSON.stringify(values)}.map(normalizeTimestamp)));`],
    { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), [UTC, '2026-10-13T00:00:00.123Z', UTC, '2024-02-29T00:00:00.000Z'], TZ);
  }
});

test('append は存在しない日付を含む不正な source_ts と observed_ts を追記前に拒否する', t => {
  const { ledger } = createFixture(t);
  for (const value of ['garbage', '2026-02-30T00:00:00Z', '2026-02-29T09:00:00+0900',
    '2026-04-31T00:00:00', '2026-13-01T00:00:00Z', '2026-10-13T24:00:00Z']) {
    for (const field of ['source_ts', 'observed_ts']) {
      assert.throws(() => ledger.append({ source: 'ui', source_event_id: `${field}:${value}`,
        kind: 'run.created', subject: 'run:r', confidence: 'confirmed', source_ts: UTC, observed_ts: UTC,
        payload: { conversation_id: 'c', generation: 1, state: 'idle' }, [field]: value }), TypeError, `${field}: ${value}`);
    }
  }
  assert.deepEqual(ledger.readSince(0, 100), []);
});

test('不正な payload の時刻があっても純粋投影・増分投影・再構築と後続の事実は止まらない', t => {
  const { ledger, db, append } = createFixture(t);
  const invalid = 'garbage';
  ledger.append({ source: 'ui', source_event_id: 'bad-run', kind: 'run.created', subject: 'run:r',
    source_ts: UTC, confidence: 'confirmed', payload: { conversation_id: 'c', generation: 1, state: 'running',
      started_ts: invalid, last_evidence_ts: invalid } });
  append('connection.created', 'connection:x', { run_id: 'r', type: 'ws', fingerprint: 'x', state: 'connected', last_evidence_ts: invalid });
  append('run.created', 'run:calendar', { conversation_id: 'c2', generation: 1, state: 'idle', started_ts: '2026-02-30T00:00:00Z' });
  const facts = ledger.readSince(0, 100);
  const original = JSON.stringify(facts);
  assert.equal(projectEntities(facts, 'run').find(row => row.id === 'r')!.started_ts, invalid);
  assert.equal(projectEntityRecords<{ started_ts: string }>(facts, 'run').find(row => row.id === 'r')!.started_ts, invalid);
  const projection = project(facts);
  assert.equal(projection.runs.find(row => row.conversation_id === 'c')!.started_ts, invalid);
  assert.equal(projection.runs.find(row => row.conversation_id === 'c2')!.started_ts, '2026-02-30T00:00:00Z');
  assert.equal(projection.connections[0].last_evidence_ts, invalid);
  assert.equal(JSON.stringify(facts), original);
  const state = applyIncremental(db, 0);
  assert.equal(state.last_seq, facts.at(-1)!.seq);
  append('run.updated', 'run:r', { generation: 1, model: 'later' });
  assert.equal(applyIncremental(db, state.last_seq).last_seq, facts.at(-1)!.seq + 1);
  const before = db.prepare('SELECT * FROM runs ORDER BY id').all();
  assert.equal(before.find(row => row.conversation_id === 'c')!.model, 'later');
  rebuild(db);
  assert.deepEqual(db.prepare('SELECT * FROM runs ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT last_evidence_ts FROM connections').get()!.last_evidence_ts, invalid);
});
function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'timestamp-'));
  const ledger = openLedger(join(directory, 'ledger.db'));
  const db = readLedgerDatabase(ledger);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true }); });
  let sequence = 0;
  const append = (kind: string, subject: string, payload: object, source_ts = OFFSET, observed_ts = OFFSET) => ledger.append({
    source: 'host-codex', source_event_id: `event:${++sequence}`, kind, subject, payload,
    source_ts, observed_ts, confidence: 'confirmed',
  } as FactInput);
  return { ledger, db, append };
}

test('append は全出所の時刻列だけを正規化し、payload・ハッシュ・再送の同一性を保つ', t => {
  const { ledger, db } = createFixture(t);
  for (const source of ['transcript-claude', 'rollout-codex', 'kit', 'hook', 'host-claude', 'host-codex', 'ui', 'intake'] as const) {
    const input: FactInput = { source, source_event_id: source, source_ts: OFFSET, observed_ts: '2026-10-13T00:00:00.123456Z',
      kind: 'run.created', subject: `run:${source}`, confidence: 'confirmed',
      payload: { conversation_id: 'c', generation: 1, state: 'idle', started_ts: OFFSET } };
    const before = JSON.stringify(input);
    assert.equal(ledger.append(input).status, 'appended');
    const row = ledger.readSince(0, 100).at(-1)!;
    assert.equal(row.source_ts, UTC);
    assert.equal(row.observed_ts, '2026-10-13T00:00:00.123Z');
    assert.equal((row.payload as { started_ts?: string }).started_ts, OFFSET);
    assert.equal(ledger.append({ ...input, source_ts: UTC }).status, 'duplicate');
    assert.equal(ledger.readSince(row.seq - 1, 1)[0].payload_hash, row.payload_hash);
    assert.equal(JSON.stringify(input), before);
  }
  assert.equal(db.prepare('SELECT count(*) AS count FROM facts WHERE julianday(source_ts) IS NULL OR julianday(observed_ts) IS NULL').get()!.count, 0);
  assert.equal(normalizeTimestamp('2026-10-12T19:00:00.1-0500'), '2026-10-13T00:00:00.100Z');
  assert.equal(normalizeTimestamp('2026-10-13T09:00:00.999999+09:00'), '2026-10-13T00:00:00.999Z');
  assert.throws(() => normalizeTimestamp('invalid'), TypeError);
});

test('混在する時刻は文字列・julianday で同順となり、小数秒と時差付きの期間境界を含む', t => {
  const { ledger, db, append } = createFixture(t);
  const times = ['2026-10-13T00:00:00.100000Z', '2026-10-13T09:00:01+0900', '2026-10-12T19:00:00-0500', '2026-10-13T00:00:00.09Z'];
  for (const [index, time] of times.entries()) append('message.created', `message:m${index}`, { role: 'user', version: 1, body: `needle ${index}`, body_state: 'stored' }, time);
  applyIncremental(db, 0);
  const order = (expression: string) => db.prepare(`SELECT id FROM messages ORDER BY ${expression}, id`).all().map(row => row.id);
  assert.deepEqual(order('source_ts'), ['m2', 'm3', 'm0', 'm1']);
  assert.deepEqual(order('julianday(source_ts)'), order('source_ts'));
  const result = searchLedger(db, { query: 'needle', from: '2026-10-13T09:00:00.09000+0900', to: '2026-10-12T19:00:00.100000-0500' });
  assert.deepEqual(result.results.map(row => row.message_id), ['m0', 'm3']);
  const before = db.prepare('SELECT * FROM messages ORDER BY id').all();
  rebuild(db);
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), before);
  assert.equal(ledger.readSince(0, 100).length, 4);
});

test('旧い台帳を純粋投影しても payload の時刻と作成時刻とキャッシュが揃い、入力は不変', () => {
  const inputs = [
    ['conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c', origin: 'observed', type: 'interactive' }, '2026-10-13T00:30:00Z'],
    ['conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c' }, OFFSET],
    ['run.created', 'run:r', { conversation_id: 'c', generation: 1, state: 'running', started_ts: OFFSET, last_evidence_ts: OFFSET }, OFFSET],
    ['connection.created', 'connection:x', { run_id: 'r', type: 'ws', fingerprint: 'x', state: 'connected', last_evidence_ts: OFFSET }, OFFSET],
    ['approval.created', 'approval:a', { run_id: 'r', state: 'pending' }, OFFSET],
    ['message.created', 'message:m', { role: 'user', version: 1, body: 'hello', body_state: 'stored' }, OFFSET],
    ['conversation.input_queue_changed', 'conversation:c', { input_queue_event: { operation: 'enqueue', body: 'queued' } }, OFFSET],
  ];
  const facts = inputs.map(([kind, subject, payload, source_ts], index) => ({ kind, subject, payload, source_ts, observed_ts: OFFSET,
    source: 'host-codex', confidence: 'confirmed', fact_id: `f${index}`, source_event_id: `e${index}`, seq: index + 1, schema_version: 1, payload_hash: 'hash' })) as Fact[];
  const original = JSON.stringify(facts);
  const projection = project(facts);
  assert.equal(projection.conversations[0].created_ts, UTC);
  assert.equal(projection.conversations[0].pending_inputs?.[0].source_ts, UTC);
  assert.equal(projection.runs[0].started_ts, UTC);
  assert.equal(projection.runs[0].last_evidence_ts, UTC);
  assert.equal(projection.connections[0].last_evidence_ts, UTC);
  assert.equal(projection.approvals[0].requested_ts, UTC);
  assert.equal(projection.messages[0].source_ts, UTC);
  assert.equal(projectEntityRecords<{ started_ts: string }>(facts, 'run')[0].started_ts, UTC);
  assert.deepEqual(project([...facts].reverse()), projection);
  assert.equal(JSON.stringify(facts), original);
});

test('既存行は payload と版を変えず一度の補完で直り、再実行と増分投影で戻らない', t => {
  const { db, append } = createFixture(t);
  append('conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c', origin: 'observed', type: 'interactive' }, '2026-10-13T00:30:00Z');
  append('conversation.created', 'conversation:c', { provider: 'codex', native_id: 'c' });
  append('run.created', 'run:r', { conversation_id: 'c', generation: 1, state: 'idle', started_ts: OFFSET });
  append('message.created', 'message:m', { role: 'user', body: 'last message', version: 1, body_state: 'stored' });
  append('message_membership.created', 'message_membership:mm', { message_id: 'm', conversation_id: 'c', active: true });
  applyIncremental(db, 0);
  const identity = '["codex","c"]';
  db.prepare('UPDATE facts SET source_ts = ?, observed_ts = ? WHERE seq > 1').run(OFFSET, OFFSET);
  db.prepare('UPDATE messages SET source_ts = ?').run(OFFSET);
  db.prepare('UPDATE runs SET started_ts = ?').run(OFFSET);
  db.prepare('UPDATE search_documents SET source_ts = ?').run(OFFSET);
  db.prepare('UPDATE conversations SET created_ts = ?').run('2026-10-13T00:30:00Z');
  db.prepare("UPDATE projection_records SET data = json_set(data, '$.source_ts', ?) WHERE projection = 'messages'").run(OFFSET);
  db.prepare("UPDATE entity_records SET data = json_set(data, '$.started_ts', ?) WHERE entity = 'run'").run(OFFSET);
  db.exec(`CREATE TABLE api_message_order (message_id TEXT, timestamp REAL);
    INSERT INTO api_message_order VALUES ('m', NULL);
    CREATE TABLE api_conversation_summaries (id TEXT PRIMARY KEY, message_count INTEGER, last_message_ts TEXT, last_message_excerpt TEXT);`);
  db.prepare('INSERT INTO api_conversation_summaries VALUES (?, 1, NULL, ?)').run(identity, 'wrong');
  const immutable = db.prepare('SELECT seq, fact_id, source_event_id, payload, payload_hash FROM facts ORDER BY seq').all();
  const version = db.prepare('SELECT version FROM schema_version').get();
  const projectionVersion = db.prepare('SELECT version FROM runner_projection_version').get();
  const result = normalizeLedgerTimestamps(db);
  assert.ok(result.changes.facts);
  assert.equal(db.prepare('SELECT created_ts FROM conversations').get()!.created_ts, UTC);
  assert.equal(db.prepare("SELECT json_extract(data, '$.created_ts') AS ts FROM projection_records WHERE projection = 'conversations'").get()!.ts, UTC);
  assert.equal(db.prepare("SELECT json_extract(data, '$.started_ts') AS ts FROM entity_records WHERE entity = 'run'").get()!.ts, UTC);
  assert.equal(db.prepare('SELECT julianday(source_ts) AS ts FROM facts WHERE seq = 2').get()!.ts, db.prepare('SELECT timestamp FROM api_message_order').get()!.timestamp);
  assert.equal(db.prepare('SELECT last_message_excerpt FROM api_conversation_summaries').get()!.last_message_excerpt, 'last message');
  assert.deepEqual(db.prepare('SELECT seq, fact_id, source_event_id, payload, payload_hash FROM facts ORDER BY seq').all(), immutable);
  assert.deepEqual(db.prepare('SELECT version FROM schema_version').get(), version);
  assert.deepEqual(db.prepare('SELECT version FROM runner_projection_version').get(), projectionVersion);
  assert.deepEqual(normalizeLedgerTimestamps(db), { changes: {}, generation: result.generation });
  append('run.updated', 'run:r', { generation: 1, last_evidence_ts: OFFSET });
  applyIncremental(db, 0);
  assert.equal(db.prepare('SELECT started_ts FROM runs').get()!.started_ts, UTC);
});

test('補完中の書き込み失敗は時刻列・世代・完了印をすべて rollback し、再試行できる', t => {
  const { db, append } = createFixture(t);
  append('run.created', 'run:r', { conversation_id: 'c', generation: 1, state: 'idle', started_ts: OFFSET });
  applyIncremental(db, 0);
  db.prepare('UPDATE facts SET source_ts = ?').run(OFFSET);
  db.prepare('UPDATE runs SET started_ts = ?').run(OFFSET);
  const before = db.prepare('SELECT * FROM projection_state').all();
  db.exec("CREATE TRIGGER reject_timestamp_repair BEFORE UPDATE ON runs BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => normalizeLedgerTimestamps(db, { once: true }), /injected failure/);
  assert.equal(db.prepare('SELECT source_ts FROM facts').get()!.source_ts, OFFSET);
  assert.deepEqual(db.prepare('SELECT * FROM projection_state').all(), before);
  assert.equal(hasNormalizedLedgerTimestamps(db), false);
  db.exec('DROP TRIGGER reject_timestamp_repair');
  assert.ok(normalizeLedgerTimestamps(db, { once: true }).changes.facts);
  assert.equal(hasNormalizedLedgerTimestamps(db), true);
  const generation = Number(db.prepare('SELECT generation FROM projection_state').get()!.generation);
  // 完了後の起動は表を走査しない。旧表記を再注入しても補完が再実行されない。
  db.prepare('UPDATE facts SET source_ts = ?').run(OFFSET);
  assert.deepEqual(normalizeLedgerTimestamps(db, { once: true }), { changes: {}, generation });
  assert.equal(db.prepare('SELECT source_ts FROM facts').get()!.source_ts, OFFSET);
});

test('補完は既存の不正な時刻を保持し、他の行の補完と完了印を確定する', t => {
  const { db, append } = createFixture(t);
  append('run.created', 'run:r', { conversation_id: 'c', generation: 1, state: 'idle', started_ts: 'garbage' });
  applyIncremental(db, 0);
  db.prepare('UPDATE facts SET source_ts = ?').run(OFFSET);
  const payload = db.prepare('SELECT payload, payload_hash FROM facts').get();
  const result = normalizeLedgerTimestamps(db, { once: true });
  assert.equal(result.changes.facts, 1);
  assert.equal(db.prepare('SELECT started_ts FROM runs').get()!.started_ts, 'garbage');
  assert.equal(db.prepare("SELECT json_extract(data, '$.started_ts') AS ts FROM entity_records WHERE entity = 'run'").get()!.ts, 'garbage');
  assert.deepEqual(db.prepare('SELECT payload, payload_hash FROM facts').get(), payload);
  assert.equal(hasNormalizedLedgerTimestamps(db), true);
});

test('保持期間の境界は observed_ts と cutoff の時差・小数秒を吸収し、同時刻を残す', t => {
  const { ledger, append } = createFixture(t);
  append('message.created', 'message:old', { body: 'old' }, OFFSET, '2026-10-13T08:59:59.999999+0900');
  append('message.created', 'message:equal', { body: 'equal' }, OFFSET, OFFSET);
  assert.equal(ledger.purgePayloads('2026-10-12T19:00:00-0500'), 1);
  const rows = ledger.readSince(0, 100);
  assert.equal(rows[0].payload, null);
  assert.deepEqual(rows[1].payload, { body: 'equal' });
  assert.equal(readLedgerDatabase(ledger).prepare('SELECT count(*) AS count FROM facts WHERE payload IS NULL').get()!.count, 1);
});
