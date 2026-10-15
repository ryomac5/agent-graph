import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createNativeId, readLedgerDatabase, rebuild } from '../../core/src/ledger/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import { openObservationService } from '../src/service/index.ts';
import { createHookFacts } from '../src/hook/index.ts';
import { observeClaudeFile } from '../src/observe/claude/index.ts';
import { observeClaudeContext } from '../src/observe/claude/context.ts';
const NOW = Date.parse('2026-10-15T00:00:00Z');
function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => NOW + 1000);
  const home = mkdtempSync(join(tmpdir(), 'api-roots-'));
  const service = openObservationService({ home, env: {}, dbPath: join(home, 'ledger.db') });
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  function hook(name: string, prompt: string, at = NOW, id = 'root') {
    for (const fact of createHookFacts({ version: 1, session_id: id, generation: 1, event_id: `${name}:${at}`, hook_event_name: name,
      source_ts: new Date(at).toISOString(), managed: false, input: { prompt_id: prompt } })) service.ledger.append({ ...fact, observed_ts: new Date(at).toISOString() });
  }
  return { home, service, feed, hook };
}

test('native 履歴と hook から根と会話と run に同じ判定を配り、Stop だけを Idle にしない', t => {
  const f = fixture(t); f.hook('SessionStart', 'turn'); f.hook('UserPromptSubmit', 'turn', NOW + 1);
  f.feed.refresh(NOW + 1000);
  let snapshot = f.feed.snapshot();
  assert.equal(snapshot.projection.roots[0].state, 'running');
  assert.equal(snapshot.projection.conversations[0].current_run_id, String(snapshot.projection.runs[0].id).replace('claude:root', createNativeId('claude', 'root')));
  assert.equal(snapshot.projection.runs[0].turn_started_ts, new Date(NOW + 1).toISOString());
  f.hook('Stop', 'turn', NOW + 2); const patch = f.feed.refresh(NOW + 1000);
  assert.ok(patch && patch !== 'resync'); assert.equal(patch.changes.roots.upsert[0].state, 'unknown');
  const path = join(f.home, 'root.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'u', promptId: 'turn', timestamp: new Date(NOW + 1).toISOString(), message: { role: 'user', content: 'work' } }) + '\n');
  appendFileSync(path, JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'end', parentUuid: 'u', promptId: 'turn', timestamp: new Date(NOW + 3).toISOString() }) + '\n');
  observeClaudeFile(f.service.ledger, path, { observedTs: new Date(NOW + 1000).toISOString() });
  observeClaudeContext(f.service.ledger, path, { observedTs: new Date(NOW + 1000).toISOString() });
  f.feed.refresh(NOW + 1000); snapshot = f.feed.snapshot();
  assert.equal(snapshot.projection.roots[0].state, 'idle');
  const run = snapshot.projection.runs.find(row => row.decision_id)!;
  const decision = snapshot.projection.state_decisions.find(row => row.id === run.decision_id)!;
  assert.equal((decision.display as { label: string }).label, 'Idle'); assert.equal(decision.evaluatedAt, NOW + 1000);
  const before = snapshot.projection;
  const db = readLedgerDatabase(f.service.ledger); const version = db.prepare('SELECT version FROM runner_projection_version').get()!.version;
  rebuild(db); assert.equal(f.feed.refresh(NOW + 1000), 'resync');
  assert.equal(db.prepare('SELECT version FROM runner_projection_version').get()!.version, version);
  assert.deepEqual(f.feed.snapshot().projection, before);
});

test('同じ根の操作先は表示表の順で API が選び、子の待ちは親の turn を上書きしない', t => {
  const f = fixture(t);
  for (const [id, event] of [['root', 'UserPromptSubmit'], ['peer', 'Notification'], ['child', 'Notification']]) {
    f.hook('SessionStart', id, NOW, id);
    for (const fact of createHookFacts({ version: 1, session_id: id, generation: 1, event_id: 'activity', hook_event_name: event,
      source_ts: new Date(NOW + 1).toISOString(), managed: false, input: { prompt_id: id, notification_type: 'permission_prompt' } }))
      f.service.ledger.append({ ...fact, observed_ts: new Date(NOW + 1).toISOString() });
  }
  const ledger = f.service.ledger;
  ledger.append({ source: 'hook', source_event_id: 'relation', source_ts: new Date(NOW).toISOString(), kind: 'relation.created', subject: 'relation:child', confidence: 'confirmed',
    payload: { type: 'delegated', from_id: createNativeId('claude', 'root'), to_id: createNativeId('claude', 'child'), active: true, confidence: 'confirmed', evidence: {} } });
  for (const id of ['root', 'peer']) ledger.append({ source: 'kit', source_event_id: id, source_ts: new Date(NOW).toISOString(), kind: 'alias.created', subject: `alias:${id}`, confidence: 'confirmed',
    payload: { entity_id: createNativeId('claude', id), kind: 'kit', name: 'same-root' } });
  f.feed.refresh(NOW + 1000);
  const snapshot = f.feed.snapshot(); const root = snapshot.projection.roots[0];
  assert.equal(snapshot.projection.roots.length, 1); assert.equal(root.state, 'waiting_approval'); assert.equal(root.current_conversation_id, createNativeId('claude', 'peer'));
  assert.equal(snapshot.projection.conversations.find(row => row.id === createNativeId('claude', 'root'))!.state, 'running');
});
