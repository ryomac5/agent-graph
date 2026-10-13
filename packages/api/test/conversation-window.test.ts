import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyIncremental, createFactId, openLedger, readLedgerDatabase } from '../../core/src/ledger/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';

function createConversation(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'conversation-window-'));
  const path = join(directory, 'ledger.db');
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  const base = { source: 'host-codex', confidence: 'confirmed', source_ts: '2026-10-13T00:00:00Z' } as const;
  ledger.append({ ...base, source_event_id: 'conversation', subject: 'conversation:c', kind: 'conversation.created',
    payload: { provider: 'codex', native_id: 'session', origin: 'managed', type: 'interactive', history_format: 'paginated' } });
  for (let index = 0; index < 450; index++) {
    ledger.append({ ...base, source_event_id: `line:${index}`, subject: `message:m${index}`, kind: 'message.created',
      payload: { provider: 'codex', native_id: `m${index}`, version: 1, role: 'assistant', body_state: 'stored',
        body: index === 3 ? [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } }] : `Body ${index}` } });
    ledger.append({ ...base, source_event_id: `member:${index}`, subject: `message_membership:${index}`, kind: 'message_membership.created',
      payload: { message_id: `m${index}`, conversation_id: 'c', active: true } });
  }
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  t.after(() => { feed.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { feed, ledger, base };
}

test('conversation windows return only latest bodies and page backwards in numeric event order', t => {
  const { feed, ledger, base } = createConversation(t);
  const latest = feed.conversation('c', '', { latest: true });
  assert.equal(latest.projection.messages.length, 200);
  assert.equal(latest.projection.messages[0].body, JSON.stringify('Body 250'));
  assert.equal(latest.projection.messages.at(-1)!.body, JSON.stringify('Body 449'));
  assert.equal(latest.hasOlder, true);
  assert.equal(latest.next, null);
  const tiedCursor = { ...latest.olderCursor!, id: '["codex","m251"]' };
  const tiedWindow = feed.conversation('c', '', { before: JSON.stringify(tiedCursor) });
  assert.equal(tiedWindow.projection.messages[0].body, JSON.stringify('Body 51'));
  assert.equal(tiedWindow.projection.messages.at(-1)!.body, JSON.stringify('Body 250'));
  const before = String(latest.projection.messages[0].id);
  const older = feed.conversation('c', '', { before });
  assert.equal(older.projection.messages[0].body, JSON.stringify('Body 50'));
  assert.equal(older.projection.messages.at(-1)!.body, JSON.stringify('Body 249'));
  assert.equal(older.projection.message_memberships.length, 200);
  const first = feed.conversation('c', '', { before: String(older.projection.messages[0].id) });
  assert.equal(first.projection.messages.length, 50);
  assert.equal(first.hasOlder, false);
  const anchor = feed.conversation('c', '', { message: String(older.projection.messages.at(-1)!.id) });
  assert.deepEqual(anchor.projection.messages, older.projection.messages);
  const edits = feed.conversation('c', '', { edits: true });
  assert.equal(edits.projection.messages.length, 1);
  assert.match(String(edits.projection.messages[0].body), /Edit/);
  ledger.append({ ...base, source_event_id: 'line:450', subject: 'message:m450', kind: 'message.created',
    payload: { provider: 'codex', native_id: 'm450', version: 1, role: 'assistant', body_state: 'stored', body: 'Live' } });
  ledger.append({ ...base, source_event_id: 'member:450', subject: 'message_membership:450', kind: 'message_membership.created',
    payload: { message_id: 'm450', conversation_id: 'c', active: true } });
  feed.refresh();
  assert.deepEqual(feed.conversation('c', '', { before }).projection.messages, older.projection.messages);
});

test('mixed timestamp formats keep chronological windows, summaries, and equivalent cursors', t => {
  const { feed, ledger, base } = createConversation(t);
  for (const [id, timestamp] of [['offset', '2026-10-13T09:00:00.1+0900'], ['utc', '2026-10-13T00:00:00.900000Z']]) {
    ledger.append({ ...base, source_ts: timestamp, source_event_id: id, subject: `message:${id}`, kind: 'message.created',
      payload: { provider: 'codex', native_id: id, version: 1, role: 'assistant', body_state: 'stored', body: id } });
    ledger.append({ ...base, source_event_id: `member:${id}`, subject: `message_membership:${id}`, kind: 'message_membership.created',
      payload: { message_id: id, conversation_id: 'c', active: true } });
  }
  feed.refresh();
  const latest = feed.conversation('c', '', { latest: true });
  assert.deepEqual(latest.projection.messages.slice(-2).map(row => [row.body, row.source_ts]), [
    ['"offset"', '2026-10-13T00:00:00.100Z'], ['"utc"', '2026-10-13T00:00:00.900Z'],
  ]);
  const cursor = latest.olderCursor!;
  const expected = feed.conversation('c', '', { before: cursor }).projection.messages;
  for (const source_ts of ['2026-10-13T09:00:00+0900', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00.000000Z']) {
    const equivalent = { ...cursor, source_ts };
    assert.deepEqual(feed.conversation('c', '', { before: equivalent }).projection.messages, expected);
    assert.deepEqual(feed.conversation('c', '', { before: JSON.stringify(equivalent) }).projection.messages, expected);
  }
  const conversation = feed.list('conversations').rows.find(row => row.id === '["codex","session"]')!;
  assert.equal(conversation.last_message_ts, '2026-10-13T00:00:00.900Z');
});

test('detached cursor membership still advances to the oldest window with tuple and legacy arguments', t => {
  const { feed, ledger, base } = createConversation(t);
  const latest = feed.conversation('c', '', { latest: true });
  const cursor = latest.olderCursor!;
  ledger.append({ ...base, source_ts: '2026-10-13T01:00:00Z', source_event_id: 'detach',
    subject: 'message_membership:250', kind: 'message_membership.corrected',
    supersedes: createFactId(base.source, 'member:250'), payload: { active: false } });
  feed.refresh();
  assert.equal(feed.conversation('c', '', { latest: true }).projection.messages.some(row => row.id === cursor.id), false);
  const older = feed.conversation('c', '', { before: JSON.stringify(cursor) });
  assert.equal(older.projection.messages[0].body, JSON.stringify('Body 50'));
  assert.equal(older.projection.messages.at(-1)!.body, JSON.stringify('Body 249'));
  assert.deepEqual(feed.conversation('c', '', { before: cursor.id }).projection.messages, older.projection.messages);
  assert.deepEqual(feed.conversation('c', '', { before: cursor }).projection.messages, older.projection.messages);
  const first = feed.conversation('c', '', { before: older.olderCursor! });
  assert.equal(first.projection.messages.length, 50);
  assert.equal(first.hasOlder, false);
  const empty = feed.conversation('c', '', { before: first.olderCursor! });
  assert.equal(empty.projection.messages.length, 0);
  assert.equal(empty.hasOlder, false);
  assert.equal(empty.olderCursor, null);
  // after による旧い ID 順の読み方も保つ。
  const legacy = feed.conversation('c');
  assert.equal(legacy.projection.messages.length, 200);
  assert.ok(legacy.next);
  assert.equal(feed.conversation('c', String(legacy.next)).projection.messages.length, 200);
});

test('a corrected timestamp does not skip the interval between old and new cursor positions', t => {
  const { feed, ledger, base } = createConversation(t);
  const latest = feed.conversation('c', '', { latest: true });
  const cursor = latest.olderCursor!;
  ledger.append({ ...base, source_ts: '2026-10-12T00:00:00Z', source_event_id: 'move:250',
    subject: 'message:m250', kind: 'message.corrected', supersedes: createFactId(base.source, 'line:250'),
    payload: { version: 2, body: 'Corrected 250' } });
  feed.refresh();
  const moved = feed.conversation('c', '', { before: JSON.stringify(cursor) });
  assert.equal(moved.projection.messages[0].body, JSON.stringify('Body 50'));
  assert.equal(moved.projection.messages.at(-1)!.body, JSON.stringify('Body 249'));
  // 画面と同じ ID による統合で、位置を変えた発言の再取得も一件にする。
  const rows = new Map(latest.projection.messages.map(row => [row.id, row]));
  let page = moved;
  let count = 0;
  while (true) {
    for (const row of page.projection.messages) rows.set(row.id, row);
    count++;
    assert.ok(count <= 3, 'history must advance');
    if (!page.hasOlder) break;
    page = feed.conversation('c', '', { before: page.olderCursor! });
  }
  assert.equal(rows.size, 450);
  assert.deepEqual(new Set(rows.keys()), new Set(Array.from({ length: 450 }, (_, index) => `["codex","m${index}"]`)));
  assert.equal(rows.get(cursor.id)!.body, JSON.stringify('Corrected 250'));
  assert.equal(page.hasOlder, false);
});
