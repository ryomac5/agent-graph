import { readSessionMeta } from '../../src/observe/codex/files.ts';
import { collectProjectionDependencies } from '../../../core/src/ledger/projections/dependencies.ts';
import { DatabaseSync } from 'node:sqlite';
import { readLedgerDatabase } from '../../../core/src/ledger/repository.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, appendFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createDirectCodexObserver, findCodexExecs, matchesCodexExec, readRolloutRequest } from '../../src/observe/direct-codex.ts';
import type { Launch, RolloutRequest } from '../../src/observe/direct-codex.ts';
import { openObservationService } from '../../src/service/index.ts';

const TS = '2026-10-11T01:00:00.000Z';
const launch: Launch = { parent: 'parent', key: 'launch', toolUseId: 'tool', timestamp: TS, cwd: '/repo', promptPath: '/prompt' };
const rollout: RolloutRequest = { id: 'child', timestamp: '2026-10-11T01:01:00.000Z', cwd: '/repo', prompt: '# Work\nFirst\nSecond\nMore' };
test('finds direct and background commands, quoted paths and multiple launches without executing shell text', () => {
  assert.deepEqual(findCodexExecs('codex exec -m model -C /repo - < /prompt'), [{ cwd: '/repo', promptPath: '/prompt' }]);
  assert.deepEqual(findCodexExecs('( codex exec --cd "/repo space" --output-last-message /out - < "/prompt space" ) &'), [{ cwd: '/repo space', promptPath: '/prompt space' }]);
  assert.deepEqual(findCodexExecs('command codex exec --cd=/one - </first; (codex exec -C /two - </second) &'), [{ cwd: '/one', promptPath: '/first' }, { cwd: '/two', promptPath: '/second' }]);
  assert.deepEqual(findCodexExecs('echo "codex exec -C /repo"; echo codex exec -C /repo'), []);
});
test('requires prompt prefix, launch time and cwd to agree; missing prompt uses time and cwd', () => {
  assert.equal(matchesCodexExec(launch, rollout, '# Work\nFirst\nSecond\nDifferent suffix'), true);
  assert.equal(matchesCodexExec(launch, rollout, '# Different'), false);
  assert.equal(matchesCodexExec(launch, rollout, ''), false);
  assert.equal(matchesCodexExec(launch, { ...rollout, cwd: '/other' }), false);
  assert.equal(matchesCodexExec(launch, { ...rollout, timestamp: '2026-10-11T00:59:59Z' }), false);
  assert.equal(matchesCodexExec(launch, { ...rollout, timestamp: '2026-10-11T01:02:00.001Z' }), false);
  assert.equal(matchesCodexExec(launch, { ...rollout, timestamp: '2026-10-11T01:02:00Z' }), true);
  assert.equal(matchesCodexExec(launch, { ...rollout, timestamp: 'invalid' }), false);
  assert.equal(matchesCodexExec(launch, rollout), true);
});
function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'direct-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claude = join(home, '.claude/projects/repo');
  const codex = join(home, '.codex/sessions');
  mkdirSync(claude, { recursive: true }); mkdirSync(codex, { recursive: true });
  const promptPath = join(home, 'prompt');
  const childPath = join(codex, 'rollout-child.jsonl');
  const prompt = '# Work\nFirst\nSecond';
  const rows = [
    { type: 'session_meta', payload: { id: 'child', timestamp: rollout.timestamp, cwd: home, source: 'exec' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', timestamp: rollout.timestamp, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
  ];
  writeFileSync(childPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(claude, 'parent.jsonl'), JSON.stringify({ type: 'assistant', uuid: 'message', timestamp: TS, cwd: home,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: `(codex exec -C ${home} - < ${promptPath}) &` } }] } }) + '\n');
  return { home, promptPath, childPath, prompt };
}
for (const available of [true, false]) test(`worker ingestion backfills a unique relation with prompt available=${available} and remains idempotent`, t => {
  const f = createFixture(t);
  if (available) writeFileSync(f.promptPath, f.prompt);
  assert.equal(readRolloutRequest(f.childPath)?.prompt, f.prompt);
  const service = openObservationService({ home: f.home, env: { HOME: f.home }, dbPath: join(f.home, 'ledger.db'), writerOnly: true,
    codexProcessReader: { listProcesses: () => '', readOpenFiles: () => '' } });
  t.after(() => service.close());
  service.ingestOnce();
  const relations = () => service.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === 'relation.created');
  assert.equal(relations().length, 1);
  assert.equal(relations()[0].payload?.confidence, 'inferred');
  assert.deepEqual(relations()[0].payload?.evidence, { launchKey: JSON.stringify([JSON.stringify(['claude', 'parent']), 'tool', 0]), toolUseId: 'tool', agentType: 'codex-exec', description: '# Work', promptPath: f.promptPath,
    promptMatched: available, cwd: f.home, started_ts: rollout.timestamp });
  service.ingestOnce(); assert.equal(relations().length, 1);
  const backfill = createDirectCodexObserver(service.ledger, readLedgerDatabase(service.ledger));
  backfill(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER), [f.childPath]);
  assert.equal(relations().length, 1);
});
test('ambiguous rollouts and competing launches do not create relations', t => {
  const f = createFixture(t);
  const service = openObservationService({ home: f.home, env: { HOME: f.home }, dbPath: join(f.home, 'ledger.db'), writerOnly: true,
    codexProcessReader: { listProcesses: () => '', readOpenFiles: () => '' } });
  t.after(() => service.close());
  service.ingestOnce();
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind !== 'relation.created');
  const second = join(f.home, '.codex/sessions/rollout-second.jsonl');
  writeFileSync(second, JSON.stringify({ type: 'session_meta', payload: { id: 'second', timestamp: rollout.timestamp, cwd: f.home } }) + '\n'
    + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: f.prompt } }) + '\n');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE facts (seq INTEGER, kind TEXT, subject TEXT, source TEXT, source_ts TEXT, payload TEXT)');
  db.exec('CREATE TABLE fact_projection_dependencies (projection TEXT, direction TEXT, key TEXT, subject TEXT, seq INTEGER)');
  function replaceFacts(values: typeof facts) {
    db.exec('DELETE FROM facts; DELETE FROM fact_projection_dependencies');
    const insert = db.prepare('INSERT INTO facts VALUES (?, ?, ?, ?, ?, ?)');
    const insertDependency = db.prepare('INSERT INTO fact_projection_dependencies VALUES (?, ?, ?, ?, ?)');
    for (const fact of values) {
      insert.run(fact.seq, fact.kind, fact.subject, fact.source, fact.source_ts, JSON.stringify(fact.payload));
      for (const d of collectProjectionDependencies(fact)) insertDependency.run(d.projection, d.direction, d.key, fact.subject, fact.seq);
    }
  }
  replaceFacts(facts);
  let appended = 0;
  const observer = createDirectCodexObserver({ ...service.ledger, append() { appended++; throw new Error('Unexpected append'); } }, db);
  assert.equal(observer(facts, [f.childPath, second]).matched, 0); assert.equal(appended, 0);
  const message = facts.find(fact => fact.kind === 'message.created' && fact.source === 'transcript-claude')!;
  const body = JSON.parse(JSON.stringify(message.payload));
  body.body[0].input.command += `; codex exec -C ${f.home} - < ${f.promptPath}`;
  const competing = facts.map(fact => fact === message ? { ...fact, payload: body } : fact);
  replaceFacts(competing);
  const secondObserver = createDirectCodexObserver({ ...service.ledger, append() { throw new Error('Unexpected append'); } }, db);
  assert.equal(secondObserver(competing, [f.childPath]).matched, 0);
});

test('reopening observation backfills previously ingested Claude history when the rollout arrives later', t => {
  const f = createFixture(t);
  const options = { home: f.home, env: { HOME: f.home }, dbPath: join(f.home, 'ledger.db'), writerOnly: true,
    codexProcessReader: { listProcesses: () => '', readOpenFiles: () => '' } };
  // 最初の周期では時刻の合わない記録だけがある。
  const original = readFileSync(f.childPath, 'utf8');
  writeFileSync(f.childPath, original.replaceAll(rollout.timestamp, '2026-10-11T02:00:00.000Z'));
  const first = openObservationService(options);
  first.ingestOnce();
  assert.equal(first.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === 'relation.created').length, 0);
  first.close();
  writeFileSync(f.childPath, original);
  const resumed = openObservationService(options);
  t.after(() => resumed.close());
  resumed.ingestOnce();
  assert.equal(resumed.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === 'relation.created').length, 1);
  resumed.ingestOnce();
  assert.equal(resumed.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === 'relation.created').length, 1);
});

function createPendingObserver(t: TestContext, cacheLimit = 16_384) {
  const f = createFixture(t);
  const service = openObservationService({ home: f.home, env: { HOME: f.home }, dbPath: join(f.home, 'ledger.db'), writerOnly: true,
    codexProcessReader: { listProcesses: () => '', readOpenFiles: () => '' } });
  t.after(() => service.close());
  // 取り込み時は子の開始を一致させず、未結合の手がかりを用意する。
  const original = readFileSync(f.childPath, 'utf8');
  writeFileSync(f.childPath, original.replaceAll(rollout.timestamp, '2026-10-11T02:00:00.000Z'));
  service.ingestOnce();
  writeFileSync(f.childPath, original);
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const reads = { meta: 0, request: 0 };
  const observer = createDirectCodexObserver(service.ledger, readLedgerDatabase(service.ledger), { cacheLimit,
    readMeta(path) { reads.meta++; return readSessionMeta(path); },
    readRequest(path, meta) { reads.request++; return readRolloutRequest(path, meta); } });
  return { ...f, service, facts, reads, observer, original };
}

test('unchanged ambiguous rollouts reuse prefixes; changing one file invalidates only that file and deletion allows linking', t => {
  const f = createPendingObserver(t);
  const other = join(f.home, '.codex/sessions/rollout-other.jsonl');
  writeFileSync(other, f.original.replaceAll('child', 'other'));
  assert.equal(f.observer(f.facts, [f.childPath, other]).matched, 0);
  assert.deepEqual(f.reads, { meta: 2, request: 2 });
  f.observer([], [f.childPath, other]);
  assert.deepEqual(f.reads, { meta: 2, request: 2 });
  appendFileSync(other, '\n');
  f.observer([], [f.childPath, other]);
  assert.deepEqual(f.reads, { meta: 3, request: 3 });
  const stamp = statSync(other);
  utimesSync(other, stamp.atime, new Date(stamp.mtimeMs + 1000));
  f.observer([], [f.childPath, other]);
  assert.deepEqual(f.reads, { meta: 4, request: 4 });
  rmSync(other);
  assert.equal(f.observer([], [f.childPath, other]).matched, 1);
  assert.equal(f.observer([], [f.childPath]).detected, 0);
  assert.deepEqual(f.reads, { meta: 4, request: 4 });
});

test('prefix cache is capped without evicting the cached working set on every scan', t => {
  const f = createPendingObserver(t, 2);
  const paths = [f.childPath, ...['other', 'third'].map(id => {
    const path = join(f.home, `.codex/sessions/rollout-${id}.jsonl`);
    writeFileSync(path, f.original.replaceAll('child', id));
    return path;
  })];
  f.observer(f.facts, paths);
  assert.deepEqual(f.reads, { meta: 3, request: 3 });
  f.observer([], paths);
  assert.deepEqual(f.reads, { meta: 4, request: 4 });
  f.observer([], paths.slice(1));
  assert.deepEqual(f.reads, { meta: 5, request: 5 });
  f.observer([], paths.slice(1));
  assert.deepEqual(f.reads, { meta: 5, request: 5 });
});

test('missing first request is cached until the rollout grows', t => {
  const f = createPendingObserver(t);
  const meta = f.original.split('\n')[0] + '\n';
  writeFileSync(f.childPath, meta);
  f.observer(f.facts, [f.childPath]);
  f.observer([], [f.childPath]);
  assert.deepEqual(f.reads, { meta: 1, request: 1 });
  writeFileSync(f.childPath, f.original);
  assert.equal(f.observer([], [f.childPath]).matched, 1);
  assert.deepEqual(f.reads, { meta: 2, request: 2 });
});

test('location and membership arriving after the launch are queried without retaining the message body', t => {
  const f = createPendingObserver(t);
  const db = readLedgerDatabase(f.service.ledger);
  // 対象の所属と場所を検証用ビューから隠し、到着順を再現する。
  db.exec(`CREATE TEMP VIEW facts AS SELECT * FROM main.facts WHERE kind NOT LIKE 'conversation.%' AND kind != 'message_membership.created'`);
  assert.equal(f.observer(f.facts.filter(fact => fact.kind === 'message.created'), [f.childPath]).detected, 0);
  db.exec('DROP VIEW temp.facts');
  const membership = f.facts.find(fact => fact.kind === 'message_membership.created' && fact.source === 'transcript-claude')!;
  const seq = Math.max(...f.facts.map(fact => fact.seq));
  f.service.ledger.append({ source: 'transcript-claude', source_event_id: 'late-membership', source_ts: TS,
    kind: 'message_membership.created', subject: membership.subject, confidence: 'confirmed',
    payload: { message_id: String((membership.payload as Record<string, unknown>).message_id),
      conversation_id: String((membership.payload as Record<string, unknown>).conversation_id), active: true } });
  assert.equal(f.observer(f.service.ledger.readSince(seq, 100), [f.childPath]).matched, 1);
  const delayed = createPendingObserver(t);
  const delayedDb = readLedgerDatabase(delayed.service.ledger);
  const message = delayed.facts.find(fact => fact.kind === 'message.created' && fact.source === 'transcript-claude')!;
  const payload = JSON.parse(JSON.stringify(message.payload));
  payload.body[0].input.command = 'codex exec -';
  delayedDb.exec(`CREATE TEMP VIEW facts AS SELECT * FROM main.facts WHERE kind NOT LIKE 'conversation.%'`);
  assert.equal(delayed.observer([{ ...message, payload }], [delayed.childPath]).matched, 0);
  delayedDb.exec('DROP VIEW temp.facts');
  assert.equal(delayed.observer([], [delayed.childPath]).matched, 1);
});

test('a relation arriving from another observer removes the pending launch on the next idle cycle', t => {
  const f = createPendingObserver(t);
  f.observer(f.facts, []);
  const parent = JSON.stringify(['claude', 'parent']);
  const key = JSON.stringify([parent, 'tool', 0]);
  f.service.ledger.append({ source: 'transcript-claude', source_event_id: 'external-relation', source_ts: TS,
    kind: 'relation.created', subject: 'relation:external', confidence: 'inferred',
    payload: { type: 'delegated', from_id: parent, to_id: JSON.stringify(['codex', 'child']),
      evidence: { launchKey: key }, active: true, confidence: 'inferred' } });
  assert.equal(f.observer([], [f.childPath]).detected, 0);
  assert.deepEqual(f.reads, { meta: 0, request: 0 });
});
