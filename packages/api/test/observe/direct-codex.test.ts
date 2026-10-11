import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  const backfill = createDirectCodexObserver(service.ledger);
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
  let appended = 0;
  const observer = createDirectCodexObserver({ ...service.ledger, append() { appended++; throw new Error('Unexpected append'); } });
  assert.equal(observer(facts, [f.childPath, second]).matched, 0); assert.equal(appended, 0);
  const message = facts.find(fact => fact.kind === 'message.created' && fact.source === 'transcript-claude')!;
  const body = JSON.parse(JSON.stringify(message.payload));
  body.body[0].input.command += `; codex exec -C ${f.home} - < ${f.promptPath}`;
  const competing = facts.map(fact => fact === message ? { ...fact, payload: body } : fact);
  const secondObserver = createDirectCodexObserver({ ...service.ledger, append() { throw new Error('Unexpected append'); } });
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
