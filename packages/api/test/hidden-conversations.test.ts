import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openObservationService } from '../src/service/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import { project, projectRoots, rebuild } from '../../core/src/ledger/index.ts';
import { createLocationResolver } from '../src/observe/location.ts';
import { createHookFacts } from '../src/hook/index.ts';
import { observeClaudeFile } from '../src/observe/claude/index.ts';
import { SMOKE_DIRECTORY } from '../src/verification.ts';

const ts = '2026-10-14T00:00:00.000Z';
const id = (native: string) => JSON.stringify(['claude', native]);

test('非表示は差分・再接続・再構築・一覧の頁と件数に反映し、直接表示と通常の会話を保つ', t => {
  const home = mkdtempSync(join(tmpdir(), 'hidden-conversations-'));
  const dbPath = join(home, 'ledger.db');
  const service = openObservationService({ home, env: {}, dbPath });
  let feed = new ProjectionFeed(dbPath, service.catchUp);
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); feed.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  for (let i = 0; i < 1003; i++) {
    const native = String(i).padStart(4, '0');
    service.ledger.append({ source: 'host-claude', source_event_id: `create:${native}`, kind: 'conversation.created',
      subject: `conversation:claude:${native}`, source_ts: ts, confidence: 'confirmed',
      payload: { provider: 'claude', native_id: native, origin: 'observed', type: 'interactive', history_format: 'jsonl' } });
  }
  service.ledger.append({ source: 'transcript-claude', source_event_id: 'message', kind: 'message.created',
    subject: 'message:text', source_ts: ts, confidence: 'confirmed',
    payload: { provider: 'claude', native_id: 'text', version: 1, role: 'user', body: 'still readable', body_state: 'stored' } });
  service.ledger.append({ source: 'transcript-claude', source_event_id: 'member', kind: 'message_membership.created',
    subject: 'message_membership:text', source_ts: ts, confidence: 'confirmed',
    payload: { conversation_id: 'claude:0000', message_id: 'text', active: true } });
  feed.refresh();
  const before = feed.snapshot();
  const input = { source: 'ui', source_event_id: 'hide', kind: 'conversation.hidden', subject: `conversation:${id('0000')}`,
    source_ts: ts, confidence: 'confirmed', payload: { hidden: true, hidden_reason: 'verification' } } as const;
  assert.equal(service.ledger.append(input).status, 'appended');
  assert.equal(service.ledger.append(input).status, 'duplicate');
  // 別名の subject による非表示と、頁の境界の非表示も確認する。
  service.ledger.append({ ...input, source_event_id: 'hide-last', subject: 'conversation:claude:1000' });
  const patch = feed.refresh();
  assert.ok(patch && patch !== 'resync');
  assert.deepEqual(patch.changes.conversations.remove.sort(), [id('0000'), id('1000')]);
  assert.equal(patch.changes.conversations.upsert.length, 0);
  assert.deepEqual(patch.changes.roots.remove.sort(), [id('0000'), id('1000')]);
  assert.deepEqual(feed.replay(before.seq, before.generation)?.at(-1), patch);
  function check() {
    const snapshot = feed.snapshot();
    assert.equal(snapshot.pages.conversations.total, 1001);
    assert.equal(snapshot.pages.roots.total, 1001);
    for (const table of ['conversations', 'roots']) {
      const first = feed.list(table);
      assert.equal(first.rows.length, 1000);
      assert.ok(first.next);
      const second = feed.list(table, String(first.next));
      assert.equal(second.rows.length, 1);
      assert.equal(second.next, null);
      const ids = [...first.rows, ...second.rows].map(row => row.id);
      assert.ok(!ids.includes(id('0000')) && !ids.includes(id('1000')));
      assert.equal(ids.filter(value => value === id('0001')).length, 1);
    }
    const detail = feed.conversation('claude:0000');
    assert.equal(detail.projection.conversations[0].id, id('0000'));
    assert.equal(detail.projection.messages.length, 1);
    assert.match(String(detail.projection.messages[0].body), /still readable/);
    assert.equal(feed.conversation(id('0001')).projection.conversations.length, 1);
  }
  check();
  // 後続の観測で会話の非表示が解除されない。
  service.ledger.append({ source: 'host-claude', source_event_id: 'later', kind: 'conversation.updated',
    subject: 'conversation:claude:0000', source_ts: '2026-10-15T00:00:00.000Z', confidence: 'confirmed', payload: { ai_title: 'later' } });
  feed.refresh(); check();
  const facts = service.ledger.readSince(0, 10000);
  assert.deepEqual(project(facts).roots, project([...facts].reverse()).roots);
  assert.ok(!project(facts).roots.some(row => row.id === id('0000')));
  rebuild(db); feed.refresh(); check();
  feed.close(); feed = new ProjectionFeed(dbPath, service.catchUp); check();
  assert.equal(db.prepare('SELECT count(*) AS n FROM facts WHERE kind = ?').get('conversation.hidden')!.n, 2);
});

test('確認 cwd の起動を最初から非表示にし、近い名前の cwd は通常のままにする', () => {
  const locate = createLocationResolver(() => ({ status: 1, stdout: '' }));
  assert.equal(locate(SMOKE_DIRECTORY).hidden, true);
  assert.equal(locate(`${SMOKE_DIRECTORY}-user`).hidden, undefined);
  const facts = createHookFacts({ version: 1, session_id: 'smoke', generation: 1, event_id: 'start',
    hook_event_name: 'SessionStart', source_ts: ts, input: { cwd: SMOKE_DIRECTORY }, managed: false }, locate);
  assert.ok(facts.some(fact => fact.kind === 'conversation.created' && fact.payload.hidden));
});

test('非表示の継続元に結ばれていても、非表示でない会話の根を失わない', () => {
  const roots = projectRoots([
    { id: 'parent', type: 'interactive', hidden: true },
    { id: 'child', type: 'interactive' },
  ], [{ from_id: 'parent', to_id: 'child', type: 'continued', active: true, confidence: 'confirmed' }]);
  assert.deepEqual(roots.map(row => row.id), ['child']);
});

for (const source of ['hook', 'transcript'] as const) test(source + ': 確認会話は最初の snapshot から非表示で直接取得できる', t => {
  const home = mkdtempSync(join(tmpdir(), 'hidden-launch-'));
  const dbPath = join(home, 'ledger.db');
  const service = openObservationService({ home, env: {}, dbPath });
  let feed: ProjectionFeed | undefined;
  t.after(() => { feed?.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  if (source === 'hook') {
    const locate = createLocationResolver(() => ({ status: 1, stdout: '' }));
    for (const fact of createHookFacts({ version: 1, session_id: 'smoke', generation: 1, event_id: 'start',
      hook_event_name: 'SessionStart', source_ts: ts, input: { cwd: SMOKE_DIRECTORY }, managed: false }, locate)) service.ledger.append(fact);
  } else {
    const path = join(home, 'smoke.jsonl');
    writeFileSync(path, JSON.stringify({ type: 'user', uuid: 'first', timestamp: ts, sessionId: 'smoke',
      cwd: SMOKE_DIRECTORY, message: { role: 'user', content: 'OK' } }) + '\n');
    observeClaudeFile(service.ledger, path);
  }
  feed = new ProjectionFeed(dbPath, service.catchUp);
  assert.equal(feed.snapshot().projection.conversations.length, 0);
  assert.equal(feed.snapshot().projection.roots.length, 0);
  assert.equal(feed.conversation(id('smoke')).projection.conversations[0].hidden, 1);
});
