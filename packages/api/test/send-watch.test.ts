import { promptFrame } from './terminal-screen-fixture.ts';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import type { IPty } from 'node-pty';
import type { RunnerRequest } from '../src/runner-client.ts';
import { startWebSocketServer, type WebSocketOptions } from '../src/ws/index.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openLedger, type FactInput } from '../../core/src/ledger/index.ts';
import { openObservationService } from '../src/service/index.ts';
import { ProjectionFeed } from '../src/service/projection-feed.ts';
import { SendWatch, SEND_WATCH_TIMEOUT_MS, SEND_WATCH_FAILED_RETENTION_MS, SEND_WATCH_CLOSED_RETENTION_MS, SEND_WATCH_PENDING_MAX_AGE_MS, SEND_WATCH_CLEANUP_INTERVAL_MS, normalizeSentBody } from '../src/service/send-watch.ts';
import { observeClaudeFile } from '../src/observe/claude/index.ts';
import { createHookFacts } from '../src/hook/index.ts';

const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const CONVERSATION = JSON.stringify(['claude', 'fixture']);
function createFixture(t: TestContext, busy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ag-send-watch-'));
  const path = join(directory, 'ledger.db');
  const ledger = openLedger(path);
  let event = 0;
  function append(kind: FactInput['kind'], subject: FactInput['subject'], payload: FactInput['payload'], now: number | string = NOW) {
    ledger.append({ source: 'host-claude', source_event_id: `test-${++event}`, kind, subject, payload,
      source_ts: typeof now === 'string' ? now : new Date(now).toISOString(), observed_ts: new Date(typeof now === 'string' ? NOW : now).toISOString(), confidence: 'confirmed' } as FactInput);
  }
  append('conversation.created', `conversation:${CONVERSATION}`, { provider: 'claude', native_id: 'fixture', origin: 'observed', type: 'interactive' });
  append('run.created', 'run:root', { conversation_id: CONVERSATION, generation: 1, state: busy ? 'running' : 'idle', started_ts: new Date(NOW).toISOString() });
  const service = openObservationService({ dbPath: path });
  const feed = new ProjectionFeed(path, service.catchUp);
  const watch = new SendWatch(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); watch.close(); feed.close(); service.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = (id = 'send') => db.prepare('SELECT * FROM api_send_watches WHERE id = ?').get(id)!;
  return { directory, ledger, service, append, feed, watch, read };
}
function record(f: ReturnType<typeof createFixture>, body = 'Next step') {
  f.watch.record('send', CONVERSATION, body, f.watch.capture(CONVERSATION, NOW));
}
test('SessionEnd 後の新ターンを feed と送信監視が作業中として扱い、旧 Queued を復活させない', t => {
  const f = createFixture(t);
  const hook = (name: string, now: number) => {
    for (const fact of createHookFacts({ version: 1, session_id: 'fixture', generation: 1, run_id: 'root',
      event_id: name, hook_event_name: name, source_ts: new Date(now).toISOString(), managed: false,
      input: { session_id: 'fixture', reason: 'other' } })) f.ledger.append(fact);
    f.feed.refresh();
  };
  const enqueue = (body: string, now: number) => f.append('conversation.input_queue_changed', `conversation:${CONVERSATION}`,
    { input_queue_event: { operation: 'enqueue', body } }, now);
  enqueue('Old input', NOW + 1);
  hook('SessionEnd', NOW + 1000);
  enqueue('Queued after end', NOW + 1500);
  hook('UserPromptSubmit', NOW + 2000);
  const snapshot = f.feed.snapshot();
  assert.equal(snapshot.projection.runs[0].state, 'running');
  assert.equal(snapshot.projection.roots[0].state, 'running');
  assert.equal(snapshot.projection.runs[0].turn_started_ts, new Date(NOW + 2000).toISOString());
  const queued = snapshot.projection.conversations[0].pending_inputs as { body: string }[];
  assert.deepEqual(queued.map(row => row.body), ['Queued after end']);
  const captured = f.watch.capture(CONVERSATION, NOW + 3000);
  assert.ok(captured.busy_run);
  f.watch.record('send', CONVERSATION, 'Next step', captured);
  const boundary = NOW + 10 * SEND_WATCH_TIMEOUT_MS;
  f.watch.check(boundary);
  assert.equal(f.read().state, 'pending');
  assert.equal(f.read().deadline_ms, null);
  // 実際の履歴側のターン完了を通し、送信期限が古い SessionEnd に引かれないことを確かめる。
  f.append('run.state_changed', 'run:root', { state: 'idle', last_evidence: { kind: 'turn_completed' } }, boundary);
  f.feed.refresh();
  f.watch.check(boundary + SEND_WATCH_TIMEOUT_MS - 1);
  assert.equal(f.read().state, 'pending');
  t.mock.method(console, 'error', () => {});
  f.watch.check(boundary + SEND_WATCH_TIMEOUT_MS);
  assert.equal(f.read().state, 'failed');
});
test('送信の時刻列を共通の UTC 形式で保存し、期間境界で失敗する', t => {
  const f = createFixture(t);
  const captured = { ...f.watch.capture(CONVERSATION, NOW), sent_ts: '2026-10-13T19:00:00+0900' };
  f.watch.record('send', CONVERSATION, 'Next step', captured);
  assert.equal(f.read().sent_ts, '2026-10-13T10:00:00.000Z');
  f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS - 1);
  assert.equal(f.read().state, 'pending');
  f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS);
  assert.equal(f.read().state, 'failed');
});
function addMessage(f: ReturnType<typeof createFixture>, id: string, body: string, role = 'user') {
  f.append('message.created', `message:${id}`, { role, body, body_state: 'stored', version: 1 });
  f.append('message_membership.created', `message_membership:${id}`, { message_id: id, conversation_id: CONVERSATION, active: true });
  f.feed.refresh();
}
test('暇な根の発言で閉じ、過去の同文と assistant の発言は採用しない', t => {
  const f = createFixture(t);
  addMessage(f, 'old', 'Next step');
  record(f);
  addMessage(f, 'assistant', 'Next step', 'assistant');
  assert.equal(f.watch.check(NOW + 1000), false);
  addMessage(f, 'user', ' <pasted_content id="1">Next step</pasted_content> [Image #1] ');
  assert.equal(f.watch.check(NOW + 2000), true);
  assert.equal(f.read().state, 'closed');
  assert.equal(f.read().message_id, 'user');
  assert.equal(f.watch.list().length, 0);
});
test('作業中は区切りまで待ち、区切りから60秒で一度だけ失敗を記録する', t => {
  const f = createFixture(t, true);
  record(f);
  const lines: string[] = [];
  t.mock.method(console, 'error', (line: string) => lines.push(line));
  assert.equal(f.watch.check(NOW + 10 * SEND_WATCH_TIMEOUT_MS), false);
  const boundary = NOW + 10 * SEND_WATCH_TIMEOUT_MS;
  f.append('run.state_changed', 'run:root', { state: 'idle', last_evidence: { kind: 'turn_completed' } }, boundary);
  f.feed.refresh();
  assert.equal(f.watch.check(boundary + SEND_WATCH_TIMEOUT_MS - 1), false);
  assert.equal(f.watch.check(boundary + SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read().state, 'failed');
  assert.equal(f.watch.list()[0].state, 'failed');
  f.watch.check(boundary + 2 * SEND_WATCH_TIMEOUT_MS);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Message delivery failed/);
});
test('待ち行列にある間は待ち、queued_command の利用者発言で閉じる', t => {
  const f = createFixture(t, true);
  record(f);
  const path = join(f.directory, 'fixture.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Next step', timestamp: new Date(NOW + 1).toISOString() }) + '\n');
  observeClaudeFile(f.ledger, path);
  f.feed.refresh();
  assert.equal(f.watch.check(NOW + 10 * SEND_WATCH_TIMEOUT_MS), false);
  writeFileSync(path, [
    { type: 'queue-operation', operation: 'remove', content: 'Next step', reason: 'absorbed_mid_turn', timestamp: new Date(NOW + 2).toISOString() },
    { type: 'attachment', uuid: 'queued', attachment: { type: 'queued_command', prompt: 'Next step', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: new Date(NOW + 2).toISOString() } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  observeClaudeFile(f.ledger, path);
  f.feed.refresh();
  assert.equal(f.watch.check(NOW + 11 * SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read().state, 'closed');
});
test('暇な根では60秒で失敗し、再送で元の未配達を閉じる', t => {
  const f = createFixture(t);
  record(f);
  t.mock.method(console, 'error', () => {});
  assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS - 1), false);
  assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS), true);
  f.watch.retry('send', CONVERSATION);
  assert.equal(f.read().state, 'retried');
  assert.equal(f.watch.list().length, 0);
});
test('画像のブロックと包みと前後の空白だけを照合から除く', () => {
  assert.equal(normalizeSentBody([{ type: 'image', source: { data: 'image' } }, { type: 'text', text: ' <pasted_content>body</pasted_content> ' }]), 'body');
  assert.notEqual(normalizeSentBody('body one'), normalizeSentBody('body  one'));
});

test('待ち行列が区切りより後に解けても、その直後には失敗にしない', t => {
  const f = createFixture(t, true);
  record(f);
  f.append('conversation.input_queue_changed', `conversation:${CONVERSATION}`, { input_queue_event: { operation: 'enqueue', body: 'Next step' } }, NOW + 1);
  f.feed.refresh();
  f.watch.check(NOW + 1000);
  f.append('run.state_changed', 'run:root', { state: 'idle' }, NOW + 2000);
  f.append('conversation.input_queue_changed', `conversation:${CONVERSATION}`, { input_queue_event: { operation: 'dequeue' } }, NOW + 3 * SEND_WATCH_TIMEOUT_MS);
  f.feed.refresh();
  const released = NOW + 3 * SEND_WATCH_TIMEOUT_MS;
  assert.equal(f.watch.check(released), false);
  assert.equal(f.read().deadline_ms, released + SEND_WATCH_TIMEOUT_MS);
});

test('api が開き直しても未配達と見張りを保持し、同じ cmd_id の再記録は増えない', t => {
  const f = createFixture(t);
  record(f);
  record(f, 'Replacement');
  const reopened = new SendWatch(join(f.directory, 'ledger.db'));
  t.after(() => reopened.close());
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].body, 'Next step');
  t.mock.method(console, 'error', () => {});
  assert.equal(reopened.check(NOW + SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read().state, 'failed');
});

test('runner の書き込みロック中も主スレッドを塞がず、配達確認を保存する', async t => {
  const f = createFixture(t);
  const captured = f.watch.capture(CONVERSATION, NOW);
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  t.after(() => writer.close());
  writer.exec('BEGIN IMMEDIATE');
  let yielded = false;
  const release = setTimeout(() => { yielded = true; writer.exec('ROLLBACK'); }, 20);
  t.after(() => clearTimeout(release));
  await f.watch.recordAccepted('send', CONVERSATION, 'Next step', captured);
  assert.equal(yielded, true);
  assert.equal(f.read().state, 'pending');
});

test('照合の SQLITE_BUSY は次の周期に回し、ロック解除後に閉じる', t => {
  const f = createFixture(t);
  record(f);
  addMessage(f, 'delivered', 'Next step');
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS), false);
    assert.equal(f.read().state, 'pending');
    writer.exec('ROLLBACK');
    assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS), true);
    assert.equal(f.read().state, 'closed');
  } finally { writer.close(); }
});

test('遅れて届いた発言で failed を閉じ、同じ台帳 seq の見張り一覧から消す', t => {
  const f = createFixture(t);
  record(f);
  t.mock.method(console, 'error', () => {});
  f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS);
  assert.equal(f.read().state, 'failed');
  addMessage(f, 'late', 'Next step');
  assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS + 1000), true);
  assert.equal(f.read().state, 'closed');
  assert.equal(f.read().message_id, 'late');
  assert.deepEqual(f.watch.list(), []);
});

test('failed は24時間、closed と retried は7日で本文ごと削除する', t => {
  const f = createFixture(t);
  t.mock.method(console, 'error', () => {});
  for (const id of ['closed', 'retried', 'failed']) f.watch.record(id, CONVERSATION, id, f.watch.capture(CONVERSATION, NOW));
  addMessage(f, 'delivered', 'closed');
  const failedAt = NOW + SEND_WATCH_TIMEOUT_MS;
  f.watch.check(failedAt);
  f.watch.retry('retried', CONVERSATION, failedAt);
  assert.equal(f.read('closed').state, 'closed');
  assert.equal(f.read('retried').state, 'retried');
  assert.equal(f.read('failed').state, 'failed');
  f.watch.check(failedAt + SEND_WATCH_FAILED_RETENTION_MS - SEND_WATCH_CLEANUP_INTERVAL_MS);
  f.watch.check(failedAt + SEND_WATCH_FAILED_RETENTION_MS - 1);
  assert.ok(f.read('failed'));
  assert.equal(f.watch.check(failedAt + SEND_WATCH_FAILED_RETENTION_MS), true);
  assert.equal(f.read('failed'), undefined);
  assert.deepEqual(f.watch.list(), []);
  f.watch.check(failedAt + SEND_WATCH_CLOSED_RETENTION_MS - SEND_WATCH_CLEANUP_INTERVAL_MS);
  f.watch.check(failedAt + SEND_WATCH_CLOSED_RETENTION_MS - 1);
  assert.ok(f.read('closed'));
  assert.ok(f.read('retried'));
  assert.equal(f.watch.check(failedAt + SEND_WATCH_CLOSED_RETENTION_MS), true);
  assert.deepEqual(f.watch.history(CONVERSATION), []);
});

test('jsonl に残ると確認できないスラッシュコマンドは見張らず、配達失敗を作らない', async t => {
  const f = createFixture(t);
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(Date, 'now', () => NOW);
  for (const body of ['/vim', '/plan', ' /help', '\n/model haiku', '/unknown', '/sample:skill target', '/compact-other']) {
    f.watch.record(body, CONVERSATION, body, f.watch.capture(CONVERSATION, NOW));
    await f.watch.recordAccepted(body, CONVERSATION, body, f.watch.capture(CONVERSATION, NOW));
  }
  assert.equal(f.watch.check(NOW + 2 * SEND_WATCH_TIMEOUT_MS), false);
  assert.deepEqual(f.watch.history(CONVERSATION), []);
  assert.deepEqual(f.watch.list(), []);
  assert.equal(errors.mock.callCount(), 0);
});

test('compact は履歴の command-name で配達を照合する', async t => {
  const f = createFixture(t);
  const errors = t.mock.method(console, 'error', () => {});
  await f.watch.recordAccepted('compact', CONVERSATION, ' /compact', f.watch.capture(CONVERSATION, NOW));
  addMessage(f, 'command', '<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>');
  assert.equal(f.watch.check(NOW + 2 * SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read('compact').state, 'closed');
  assert.equal(errors.mock.callCount(), 0);
});

test('接続先の時計の遅れと +0900 の時差は seq による照合を妨げない', t => {
  const f = createFixture(t);
  for (const [id, timestamp] of [['skew', '2026-10-13T09:59:00Z'], ['offset', '2026-10-13T18:59:00+0900']]) {
    f.watch.record(id, CONVERSATION, id, f.watch.capture(CONVERSATION, NOW));
    f.append('message.created', `message:${id}`, { role: 'user', body: id, body_state: 'stored', version: 1 }, timestamp);
    f.append('message_membership.created', `message_membership:${id}`, { message_id: id, conversation_id: CONVERSATION, active: true });
  }
  f.feed.refresh();
  assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read('skew').state, 'closed');
  assert.equal(f.read('offset').state, 'closed');
});

test('同文を2回送っても seq 順に別の発言へ割り当て、両方を閉じる', t => {
  const f = createFixture(t);
  const captured = f.watch.capture(CONVERSATION, NOW);
  f.watch.record('z-first', CONVERSATION, 'Same', captured);
  addMessage(f, 'z-first-message', 'Same');
  f.watch.record('a-second', CONVERSATION, 'Same', f.watch.capture(CONVERSATION, NOW + 1));
  addMessage(f, 'a-second-message', 'Same');
  assert.equal(f.watch.check(NOW + 1000), true);
  assert.equal(f.read('z-first').message_id, 'z-first-message');
  assert.equal(f.read('a-second').message_id, 'a-second-message');
  assert.deepEqual(f.watch.list(), []);
});

test('暇な根の期限は貼り付けの待ちが終わった recordAccepted から60秒にする', async t => {
  const f = createFixture(t);
  const captured = f.watch.capture(CONVERSATION, NOW);
  const acceptedAt = NOW + 2 * SEND_WATCH_TIMEOUT_MS;
  t.mock.method(Date, 'now', () => acceptedAt);
  t.mock.method(console, 'error', () => {});
  await f.watch.recordAccepted('send', CONVERSATION, 'Next step', captured);
  assert.equal(f.read().baseline_seq, captured.baseline_seq);
  assert.equal(f.read().deadline_ms, acceptedAt + SEND_WATCH_TIMEOUT_MS);
  assert.equal(f.watch.check(acceptedAt + SEND_WATCH_TIMEOUT_MS - 1), false);
  assert.equal(f.watch.check(acceptedAt + SEND_WATCH_TIMEOUT_MS), true);
});

async function createApiFixture(t: TestContext, f: ReturnType<typeof createFixture>, sessionHosts: WebSocketOptions['sessionHosts'] = {}) {
  // 端末の起動時刻と経過時間を同じ時計で測り、実行日による負の経過時間を防ぐ。
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const errors = t.mock.method(console, 'error', () => {});
  let handleHttp!: http.RequestListener;
  const server = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 12345 }), close: (done: () => void) => done(),
  });
  t.mock.method(http, 'createServer', (handler: http.RequestListener) => { handleHttp = handler; return server as unknown as http.Server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let connect!: (socket: unknown) => void;
  const on = WebSocketServer.prototype.on;
  t.mock.method(WebSocketServer.prototype, 'on', function (this: WebSocketServer, event: string, listener: (...args: any[]) => void) {
    if (event === 'connection') connect = listener;
    return on.call(this, event, listener);
  });
  const api = await startWebSocketServer(f.service, { port: 0, runnerPath: join(f.directory, 'absent.sock'), sessionHosts: { attachments: { directory: join(f.directory, 'attachments') }, ...sessionHosts } });
  t.mock.method(api.runner, 'request', async (request: RunnerRequest) => ({ type: 'res' as const, cmd_id: request.cmd_id, ok: true, result: {} }));
  const frames: Record<string, any>[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1, bufferedAmount: 0,
    send(body: string) { frames.push(JSON.parse(body)); }, close() {}, terminate() {},
  });
  connect(socket);
  const snapshot = api.feed.snapshot();
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation })), false);
  async function receive(message: unknown) {
    await socket.listeners('message')[0](Buffer.from(JSON.stringify(message)), false);
  }
  async function command(cmd_id: string, command: string, payload: unknown) {
    await receive({ type: 'cmd', cmd_id, command, payload });
    for (let attempt = 0; attempt < 200; attempt++) {
      const ack = frames.find(frame => frame.type === 'ack' && frame.cmd_id === cmd_id);
      if (ack) return ack;
      await delay(5);
    }
    assert.fail(`Missing ack: ${cmd_id}`);
  }
  function get(path: string) {
    let status = 0;
    let body = '';
    const response = { setHeader() {}, writeHead(code: number) { status = code; return this; }, end(value: string) { body = value; } };
    handleHttp({ method: 'GET', url: path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:12345', 'x-agent-graph-token': api.token } } as unknown as http.IncomingMessage, response as unknown as http.ServerResponse);
    assert.equal(status, 200);
    return JSON.parse(body);
  }
  return { api, frames, socket, receive, command, get, errors };
}

test('本番 api の送信経路が見張りを作り、台帳が増えなくても失敗をブラウザに配信する', async t => {
  const f = createFixture(t);
  const { api, socket, frames } = await createApiFixture(t, f);
  try {
    const command = { type: 'cmd', cmd_id: 'send', command: 'send', payload: { runId: 'root', input: { text: 'Next step' } } };
    socket.emit('message', Buffer.from(JSON.stringify(command)), false);
    await delay(20);
    assert.equal(f.read().state, 'pending');
    assert.ok(frames.some(frame => frame.type === 'ack' && frame.cmd_id === 'send' && frame.ok));
    const seq = api.feed.snapshot().seq;
    t.mock.timers.setTime(NOW + SEND_WATCH_TIMEOUT_MS);
    await delay(550);
    assert.equal(api.feed.snapshot().seq, seq);
    assert.ok(frames.some(frame => frame.type === 'send_watches' && frame.rows.some((row: { state: string }) => row.state === 'failed')));
    addMessage(f, 'late', 'Next step');
    await delay(550);
    assert.equal(f.read().state, 'closed');
    assert.deepEqual(frames.filter(frame => frame.type === 'send_watches').at(-1)!.rows, []);
  } finally { await api.close(); }
});

for (const errcode of [5, 11]) {
  test(`見張りの errcode ${errcode} が HTTP・hello・patch・runner の ack を壊さない`, async t => {
    const f = createFixture(t);
    const a = await createApiFixture(t, f);
    try {
      const failure = Object.assign(new Error('injected watch failure'), { errcode });
      t.mock.method(SendWatch.prototype, 'recordAccepted', async () => { throw failure; });
      t.mock.method(SendWatch.prototype, 'check', () => { throw failure; });
      f.append('conversation.renamed', `conversation:${CONVERSATION}`, { user_name: 'changed' });
      const snapshot = a.get('/snapshot');
      assert.ok(a.frames.some(frame => frame.type === 'patch' && frame.seq === snapshot.seq));
      assert.ok(!a.frames.some(frame => frame.type === 'resync'));
      a.get(`/conversation?id=${encodeURIComponent(CONVERSATION)}`);
      a.get('/api/search?q=changed');
      a.get(`/api/send-watches?conversation=${encodeURIComponent(CONVERSATION)}`);
      await a.receive({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation });
      assert.equal((await a.command('send', 'send', { runId: 'root', input: { text: 'Next step' } })).ok, true);
      assert.equal((await a.command('again', 'send', { runId: 'root', input: { text: 'Still alive' } })).ok, true);
      assert.ok(a.errors.mock.calls.some(call => call.arguments[0] === 'Send watch recording failed:'));
      t.mock.method(SendWatch.prototype, 'capture', () => { throw failure; });
      assert.equal((await a.command('capture-error', 'send', { runId: 'root', input: { text: 'No capture' } })).ok, true);
    } finally { await a.api.close(); }
  });
}

test('実際の SQLite ロック中も runner の ack を返し、解除後に見張りを保存する', async t => {
  const f = createFixture(t);
  const a = await createApiFixture(t, f);
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal((await a.command('send', 'send', { runId: 'root', input: { text: 'Next step' } })).ok, true);
    assert.equal(f.read(), undefined);
    a.get('/snapshot');
    writer.exec('ROLLBACK');
    for (let attempt = 0; attempt < 100 && !f.read(); attempt++) await delay(5);
    assert.equal(f.read().state, 'pending');
  } finally { writer.close(); await a.api.close(); }
});

for (const failure of ['busy', 'exception'] as const) {
  test(`端末への貼り付け後の見張り ${failure} でも成功 ack を返し、同じ cmd_id を二重送信しない`, async t => {
    const f = createFixture(t);
    const session = '12345678-1234-1234-1234-123456789abc';
    const conversationId = JSON.stringify(['claude', session]);
    f.append('project.created', 'project:project', { repository_id: 'project', root_path: f.directory, state: 'registered', display_name: 'Fixture' });
    const writes: string[] = [];
    writeFileSync(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: session }));
    const a = await createApiFixture(t, f, {
      sessionsDirectory: f.directory, listProcesses: async () => [], quietMs: 0, warmupMs: 0, submitDelayMs: 0,
      openTerminal: () => ({ pid: 1000, write: (body: string) => writes.push(body), resize() {}, kill() {},
        onData: (output: (data: string) => void) => { queueMicrotask(() => output(promptFrame())); return { dispose() {} }; }, onExit: () => ({ dispose() {} }) }) as unknown as IPty,
    });
    const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
    try {
      assert.equal((await a.command('launch', 'session.launch', { projectId: 'project', provider: 'claude', resume: session })).ok, true);
      for (let attempt = 0; attempt < 100; attempt++) {
        const hosts = await a.command(`hosts-${attempt}`, 'session.hosts', {});
        if (hosts.result.hosts.length) {
          assert.equal(hosts.result.hosts[0].startedAt, new Date(NOW).toISOString());
          break;
        }
        await delay(5);
      }
      if (failure === 'busy') writer.exec('BEGIN IMMEDIATE');
      else t.mock.method(SendWatch.prototype, 'record', () => { throw new Error('injected write failure'); });
      const payload = { conversationId, text: 'Pasted once' };
      assert.equal((await a.command('send', 'session.send', payload)).ok, true);
      assert.deepEqual(writes, ['\x15', '\x1b[200~Pasted once\x1b[201~', '\r']);
      const ackCount = a.frames.filter(frame => frame.type === 'ack' && frame.cmd_id === 'send').length;
      await a.receive({ type: 'cmd', cmd_id: 'send', command: 'session.send', payload });
      await delay(10);
      assert.equal(a.frames.filter(frame => frame.type === 'ack' && frame.cmd_id === 'send' && frame.ok).length, ackCount + 1);
      assert.equal(writes.length, 3);
      assert.equal(f.read(), undefined);
      if (failure === 'busy') {
        writer.exec('ROLLBACK');
        for (let attempt = 0; attempt < 100 && !f.read(); attempt++) await delay(5);
        assert.equal(f.read().state, 'pending');
      } else assert.ok(a.errors.mock.calls.some(call => call.arguments[0] === 'Send watch recording failed:'));
      a.get('/snapshot');
      assert.equal((await a.command('alive', 'session.hosts', {})).ok, true);
    } finally { writer.close(); await a.api.close(); }
  });
}

test('5秒を超える BUSY はメモリに残し、次の check で記録と再送元の解消をやり直す', async t => {
  const f = createFixture(t);
  const errors = t.mock.method(console, 'error', () => {});
  record(f);
  f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS);
  const acceptedAt = NOW + SEND_WATCH_TIMEOUT_MS + 1;
  t.mock.method(Date, 'now', () => acceptedAt);
  const captured = f.watch.capture(CONVERSATION, NOW);
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  try {
    writer.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    await f.watch.recordAccepted('resend', CONVERSATION, 'Next step', captured, ['image-id'], 'send');
    assert.ok(performance.now() - started >= 5000);
    assert.equal(f.read('resend'), undefined);
    assert.equal(f.watch.check(acceptedAt + 1000), false);
    assert.equal(f.read('send').state, 'failed');
    assert.ok(errors.mock.calls.some(call => call.arguments[0] === 'Send watch recording failed:'));
    writer.exec('ROLLBACK');
    assert.equal(f.watch.check(acceptedAt + 2000), true);
    assert.equal(f.read('resend').state, 'pending');
    assert.equal(f.read('resend').baseline_seq, captured.baseline_seq);
    assert.equal(f.read('resend').sent_ts, new Date(acceptedAt).toISOString());
    assert.equal(f.read('resend').deadline_ms, acceptedAt + SEND_WATCH_TIMEOUT_MS);
    assert.deepEqual(JSON.parse(String(f.read('resend').attachments)), ['image-id']);
    assert.equal(f.read('send').state, 'retried');
    assert.equal(f.watch.check(acceptedAt + 2001), false);
    assert.equal(f.watch.history(CONVERSATION).length, 2);
  } finally { writer.close(); }
});

test('BUSY 以外の記録失敗も次の check でやり直す', async t => {
  const f = createFixture(t);
  t.mock.method(Date, 'now', () => NOW);
  t.mock.method(console, 'error', () => {});
  const record = t.mock.method(f.watch, 'record', () => { throw new Error('write unavailable'); });
  await f.watch.recordAccepted('send', CONVERSATION, 'Next step', f.watch.capture(CONVERSATION, NOW));
  record.mock.restore();
  assert.equal(f.watch.check(NOW + 1), true);
  assert.equal(f.read().state, 'pending');
});

test('壊れた行を失敗にして後続を評価し、壊れた添付も一覧の配信を止めない', t => {
  const f = createFixture(t);
  const errors = t.mock.method(console, 'error', () => {});
  record(f, '');
  f.watch.record('later', CONVERSATION, 'Delivered', f.watch.capture(CONVERSATION, NOW + 1));
  addMessage(f, 'delivered', 'Delivered');
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  try { writer.prepare("UPDATE api_send_watches SET attachments = '{' WHERE id = 'send'").run(); }
  finally { writer.close(); }
  assert.equal(f.watch.check(NOW + 2), true);
  assert.equal(f.read().state, 'failed');
  assert.equal(f.read('later').state, 'closed');
  assert.equal(f.read('later').message_id, 'delivered');
  assert.deepEqual(f.watch.list()[0].attachments, []);
  const failedAt = f.read().failed_ts;
  f.watch.record('next', CONVERSATION, 'Next delivery', f.watch.capture(CONVERSATION, NOW + 3));
  addMessage(f, 'next-delivered', 'Next delivery');
  assert.equal(f.watch.check(NOW + 4), true);
  assert.equal(f.read('next').state, 'closed');
  assert.equal(f.read().failed_ts, failedAt);
  assert.equal(errors.mock.callCount(), 1);
});

for (const queued of [false, true]) {
  test(`終わらない実行の見張りは24時間で失敗にして一度だけ知らせる（待ち行列=${queued}）`, t => {
    const f = createFixture(t, true);
    const errors = t.mock.method(console, 'error', () => {});
    record(f);
    if (queued) {
      f.append('conversation.input_queue_changed', `conversation:${CONVERSATION}`, { input_queue_event: { operation: 'enqueue', body: 'Next step' } }, NOW + 1);
      f.feed.refresh();
    }
    assert.equal(f.watch.check(NOW + SEND_WATCH_PENDING_MAX_AGE_MS - 1), false);
    assert.equal(f.read().state, 'pending');
    assert.equal(f.watch.check(NOW + SEND_WATCH_PENDING_MAX_AGE_MS), true);
    assert.equal(f.read().state, 'failed');
    assert.equal(f.watch.list()[0].state, 'failed');
    assert.match(String(errors.mock.calls[0].arguments[0]), /pending age limit exceeded/);
    assert.equal(f.watch.check(NOW + SEND_WATCH_PENDING_MAX_AGE_MS + 1), false);
    assert.equal(errors.mock.callCount(), 1);
  });
}

test('掃除の DELETE は該当0件でも毎周期は走らず、1分間隔で走る', t => {
  const f = createFixture(t);
  const prepare = DatabaseSync.prototype.prepare;
  let cleanups = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('DELETE FROM api_send_watches')) cleanups++;
    return prepare.call(this, sql);
  });
  assert.equal(f.watch.check(NOW), false);
  assert.equal(cleanups, 1);
  for (let elapsed = 500; elapsed < SEND_WATCH_CLEANUP_INTERVAL_MS; elapsed += 500) f.watch.check(NOW + elapsed);
  assert.equal(cleanups, 1);
  f.watch.check(NOW + SEND_WATCH_CLEANUP_INTERVAL_MS);
  assert.equal(cleanups, 2);
});

test('掃除が BUSY でも未配信の変更を返し、次の周期で掃除を繰り返さない', t => {
  const f = createFixture(t);
  t.mock.method(console, 'error', () => {});
  record(f);
  f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS);
  const retryAt = NOW + 2 * SEND_WATCH_TIMEOUT_MS;
  f.watch.retry('send', CONVERSATION, retryAt);
  const writer = new DatabaseSync(join(f.directory, 'ledger.db'));
  const prepare = DatabaseSync.prototype.prepare;
  let cleanups = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('DELETE FROM api_send_watches')) cleanups++;
    return prepare.call(this, sql);
  });
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(f.watch.check(retryAt), true);
    assert.equal(cleanups, 1);
    assert.equal(f.watch.check(retryAt + 500), false);
    assert.equal(cleanups, 1);
  } finally { writer.close(); }
});

test('履歴に記録される compact が届かない場合は削除せず配達失敗になる', t => {
  const f = createFixture(t);
  t.mock.method(console, 'error', () => {});
  record(f, '/compact keep the summary');
  assert.equal(f.watch.check(NOW + SEND_WATCH_TIMEOUT_MS), true);
  assert.equal(f.read().state, 'failed');
  assert.equal(f.watch.list()[0].body, '/compact keep the summary');
});

test('未確認の Codex の compact は見張らない', async t => {
  const f = createFixture(t);
  const conversation = JSON.stringify(['codex', 'fixture']);
  f.append('conversation.created', `conversation:${conversation}`, { provider: 'codex', native_id: 'fixture', origin: 'observed', type: 'interactive' });
  f.feed.refresh();
  const errors = t.mock.method(console, 'error', () => {});
  await f.watch.recordAccepted('compact', conversation, '/compact', f.watch.capture(conversation, NOW));
  assert.equal(f.watch.check(NOW + 2 * SEND_WATCH_TIMEOUT_MS), false);
  assert.deepEqual(f.watch.history(conversation), []);
  assert.equal(errors.mock.callCount(), 0);
});

test('WebSocket returns panel output once and rejects subsequent sends into a model picker', async t => {
  const f = createFixture(t);
  const session = '12345678-1234-1234-1234-123456789abc';
  const conversationId = JSON.stringify(['claude', session]);
  f.append('project.created', 'project:project', { repository_id: 'project', root_path: f.directory, state: 'registered', display_name: 'Fixture' });
  writeFileSync(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: session }));
  const { HELP_PANEL, MODEL_PANEL } = await import('./terminal-screen-fixture.ts');
  let output = (_data: string) => {};
  let text = '';
  const writes: string[] = [];
  const a = await createApiFixture(t, f, {
    sessionsDirectory: f.directory, listProcesses: async () => [], quietMs: 0, warmupMs: 0, submitDelayMs: 0, wait: async () => {},
    openTerminal: () => ({ pid: 1000, resize() {}, kill() {},
      onData(callback: (data: string) => void) { output = callback; queueMicrotask(() => output(promptFrame())); return { dispose() {} }; },
      onExit: () => ({ dispose() {} }), write(data: string) {
        writes.push(data);
        if (data.includes('[200~')) text = data;
        if (data === '\r') output(text.includes('/help') ? HELP_PANEL : MODEL_PANEL);
        if (data === '\x1b') output(promptFrame());
      },
    }) as unknown as IPty,
  });
  try {
    assert.equal((await a.command('launch', 'session.launch', { projectId: 'project', provider: 'claude', resume: session })).ok, true);
    const help = await a.command('help', 'session.send', { conversationId, text: '/help' });
    assert.equal(help.ok, true);
    assert.match(help.result.command.output, /Claude understands/);
    assert.equal(help.result.command.status, 'completed');
    assert.equal(f.read('help'), undefined, 'a captured panel is not falsely timed out by the transcript watch');
    const before = writes.length;
    assert.deepEqual(await a.command('help', 'session.send', { conversationId, text: '/help' }), help);
    assert.equal(writes.length, before);
    const model = await a.command('model', 'session.send', { conversationId, text: '/model' });
    assert.equal(model.result.command.status, 'interactive');
    const blocked = await a.command('blocked', 'session.send', { conversationId, text: 'not lost' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /Terminal is not ready/);
    assert.equal(blocked.result.terminalId, model.result.terminalId);
    assert.ok(!writes.some(value => value.includes('not lost')));
    assert.equal(f.read('blocked'), undefined);
  } finally { await a.api.close(); }
});
