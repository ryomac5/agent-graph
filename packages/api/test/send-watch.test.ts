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
import { SendWatch, SEND_WATCH_TIMEOUT_MS, normalizeSentBody } from '../src/service/send-watch.ts';
import { observeClaudeFile } from '../src/observe/claude/index.ts';
import { createHookFacts } from '../src/hook/index.ts';

const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const CONVERSATION = JSON.stringify(['claude', 'fixture']);
function createFixture(t: TestContext, busy = false) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const directory = mkdtempSync(join(tmpdir(), 'ag-send-watch-'));
  const path = join(directory, 'ledger.db');
  const ledger = openLedger(path);
  let event = 0;
  function append(kind: FactInput['kind'], subject: FactInput['subject'], payload: FactInput['payload'], now: number | string = NOW, supersedes?: string) {
    ledger.append({ source: 'host-claude', source_event_id: `test-${++event}`, kind, subject, payload,
      source_ts: typeof now === 'string' ? now : new Date(now).toISOString(), observed_ts: new Date(typeof now === 'string' ? NOW : now).toISOString(), confidence: 'confirmed', supersedes } as FactInput);
  }
  append('conversation.created', `conversation:${CONVERSATION}`, { provider: 'claude', native_id: 'fixture', origin: 'observed', type: 'interactive' });
  append('run.created', 'run:root', { conversation_id: CONVERSATION, generation: 1, state: busy ? 'running' : 'idle', started_ts: new Date(NOW).toISOString() });
  const service = openObservationService({ dbPath: path, home: directory, env: {} });
  const feed = new ProjectionFeed(path, service.catchUp);
  const watch = new SendWatch(path);
  const db = new DatabaseSync(path);
  t.after(() => { db.close(); watch.close(); feed.close(); service.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const read = (id = 'send', now = Date.now()) => { watch.check(now); return watch.list().find(row => row.id === id); };
  const decide = (id = 'send', now = Date.now()) => read(id, now)?.decision as import('../../core/src/state/index.ts').DeliveryDecision;
  return { directory, ledger, service, append, feed, watch, read, decide, path, db };
}
function record(f: ReturnType<typeof createFixture>, body = 'Next step') {
  f.watch.record('send', CONVERSATION, body, f.watch.capture(CONVERSATION, NOW));
}

function addMessage(f: ReturnType<typeof createFixture>, id: string, body: string, at = NOW + 1, role = 'user') {
  f.append('message.created', `message:${id}`, { role, body, body_state: 'stored', version: 1 }, at);
  f.append('message_membership.created', `message_membership:${id}`, { message_id: id, conversation_id: CONVERSATION, active: true }, at);
  f.feed.refresh(at);
}

async function createApiFixture(t: TestContext, f: ReturnType<typeof createFixture>, sessionHosts: WebSocketOptions['sessionHosts'] = {}) {
  // 端末の起動時刻と経過時間を同じ時計で測り、実行日による負の経過時間を防ぐ。
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
    assert.equal(f.decide('help').display, 'Handled in terminal');
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
    assert.equal(f.decide('blocked').display, 'Not delivered');
  } finally { await a.api.close(); }
});

test('送出の期限は作業中・待ち行列・後の turn によって延ばさず Unconfirmed にする', t => {
  const f = createFixture(t, true); record(f);
  f.append('conversation.input_queue_changed', `conversation:${CONVERSATION}`, { input_queue_event: { operation: 'enqueue', body: 'Other' } }, NOW + 1);
  f.append('run.state_changed', 'run:root', { state: 'running' }, NOW + 50_000);
  assert.equal(f.decide('send', NOW + SEND_WATCH_TIMEOUT_MS - 1).display, 'Sending');
  const d = f.decide('send', NOW + SEND_WATCH_TIMEOUT_MS);
  assert.equal(d.display, 'Unconfirmed'); assert.equal(d.reason, 'delivery_expired'); assert.equal(d.resendAutomatically, false);
});

test('古い同文と assistant を除外し、相関のない新しい一件は Likely delivered まで', t => {
  const f = createFixture(t); addMessage(f, 'old', 'Next step', NOW - 1); record(f);
  addMessage(f, 'reply', 'Next step', NOW + 1, 'assistant');
  assert.equal(f.decide('send', NOW + 1).display, 'Sending');
  addMessage(f, 'actual', 'Next step', NOW + 2);
  assert.equal(f.decide('send', NOW + 2).display, 'Likely delivered');
  assert.equal(f.read('send', NOW + 2)?.message_id, 'actual');
  assert.equal(f.decide('send', NOW + 10 * SEND_WATCH_TIMEOUT_MS).display, 'Likely delivered');
});

test('同文を別の端末から送った二つの入力を seq で勝手に割り当てない', t => {
  const f = createFixture(t); record(f);
  addMessage(f, 'one', 'Next step', NOW + 1); addMessage(f, 'two', 'Next step', NOW + 2);
  const d = f.decide('send', NOW + 2);
  assert.equal(d.display, 'Unconfirmed'); assert.equal(d.reason, 'ambiguous_candidates');
  assert.equal(f.read('send', NOW + 2)?.message_id, undefined);
});

test('同じ対象への同文の並行操作も双方 Unconfirmed にし、一つの候補を奪わない', t => {
  const f = createFixture(t); record(f);
  f.watch.record('another', CONVERSATION, 'Next step', f.watch.capture(CONVERSATION, NOW));
  addMessage(f, 'one', 'Next step', NOW + 1);
  for (const id of ['send', 'another']) assert.equal(f.decide(id, NOW + 1).reason, 'ambiguous_candidates');
});

test('送出前の拒否と送出後の失敗を区別し、再起動は再送しない', t => {
  const f = createFixture(t); const captured = f.watch.capture(CONVERSATION, NOW);
  f.watch.begin('before', CONVERSATION, 'Before', captured); f.watch.phase('before', 'rejected', NOW);
  f.watch.begin('accepted', CONVERSATION, 'Accepted', captured);
  f.watch.begin('after', CONVERSATION, 'After', captured); f.watch.phase('after', 'emitting', NOW); f.watch.phase('after', 'aborted', NOW);
  f.watch.begin('uncertain', CONVERSATION, 'Uncertain', captured); f.watch.phase('uncertain', 'emitting', NOW);
  assert.equal(f.decide('before').display, 'Not delivered'); assert.equal(f.decide('after').display, 'Unconfirmed');
  const reopened = new SendWatch(f.path); t.after(() => reopened.close());
  const rows = reopened.list();
  assert.equal((rows.find(row => row.id === 'accepted')!.decision as { display: string }).display, 'Not delivered');
  assert.equal((rows.find(row => row.id === 'uncertain')!.decision as { display: string }).display, 'Unconfirmed');
  assert.equal(reopened.begin('uncertain', CONVERSATION, 'Uncertain', captured), false);
});

test('同じ cmd_id の異なる内容は衝突を保存し、どちらも送出し直さない', t => {
  const f = createFixture(t); record(f);
  assert.equal(f.watch.begin('send', CONVERSATION, 'Different', f.watch.capture(CONVERSATION, NOW)), false);
  assert.equal(f.decide().reason, 'cmd_id_conflict');
});

test('相関が確認できる receipt だけは遅れて届いても Delivered にできる', t => {
  const f = createFixture(t); record(f);
  const target = f.watch.capture(CONVERSATION, NOW).target;
  f.watch.add({ kind: 'binding', id: 'binding', cmdId: 'send', target, correlation: { protocol: 'codex', id: 'turn-1' }, at: NOW, observedAt: NOW });
  f.watch.add({ kind: 'receipt', id: 'receipt', target, inputId: 'input', phase: 'consumed', correlation: { protocol: 'codex', id: 'turn-1' }, at: NOW + 120_000, observedAt: NOW + 120_000 });
  assert.equal(f.decide('send', NOW + 120_000).display, 'Delivered');
});

test('走査の失敗と遅延を配達結果と別に持ち、失敗だけで Not delivered にしない', t => {
  const f = createFixture(t); record(f);
  f.watch.recordScan({ id: 'scan', at: NOW + 1, status: 'failed', sessions: [], processes: [] });
  assert.equal(f.decide('send', NOW + 1).observation, 'failed');
  assert.equal(f.decide('send', NOW + 60_000).display, 'Unconfirmed');
});

test('本文の包みは API で正規化し、画面では同文を照合しない', () => {
  assert.equal(normalizeSentBody('[Image #1] <pasted_content id="x"> hello </pasted_content>'), 'hello');
  assert.equal(normalizeSentBody('<command-name>/compact</command-name><command-args>short</command-args>'), '/compact short');
  assert.equal(normalizeSentBody('<bash-input>echo hello</bash-input>'), '!echo hello');
});

for (const body of ['! echo delivered', '!echo delivered', '!  echo delivered  ']) {
  test(`9-bang: bash-input と送信を現在の配達規則で照合する: ${body}`, t => {
    const f = createFixture(t);
    record(f, body);
    addMessage(f, 'wrong', '<bash-input> echo other</bash-input>');
    addMessage(f, 'output', '<bash-stdout>echo delivered</bash-stdout>');
    assert.equal(f.decide('send', NOW + 1000).value, 'emitted');
    addMessage(f, 'delivered', '<bash-input> echo delivered</bash-input>');
    assert.equal(f.decide('send', NOW + SEND_WATCH_TIMEOUT_MS).value, 'received_candidate');
    assert.equal(f.read('send', NOW + SEND_WATCH_TIMEOUT_MS)?.message_id, 'delivered');
  });
}

test('本番 API 経路は送出前に永続化し、seq 不変でも期限を配信する', async t => {
  const f = createFixture(t); const a = await createApiFixture(t, f);
  try {
    let sent = 0;
    t.mock.method(a.api.runner, 'request', async (request: RunnerRequest) => {
      sent++; assert.ok(f.db.prepare("SELECT 1 FROM api_delivery_evidence WHERE id = 'send:emitting'").get());
      return { type: 'res' as const, cmd_id: request.cmd_id, ok: true, result: {} };
    });
    const payload = { runId: 'root', input: { text: 'Next step' } };
    assert.equal((await a.command('send', 'send', payload)).ok, true);
    await a.command('send', 'send', payload); assert.equal(sent, 1);
    const seq = a.api.feed.snapshot().seq;
    t.mock.timers.setTime(NOW + SEND_WATCH_TIMEOUT_MS); await delay(550);
    assert.equal(a.api.feed.snapshot().seq, seq);
    assert.ok(a.frames.some(frame => frame.type === 'send_watches' && frame.rows.some((row: any) => row.decision.display === 'Unconfirmed')));
  } finally { await a.api.close(); }
});

for (const failure of ['busy', 'exception']) test(`送出前の永続化 ${failure} は runner を呼ぶ前に拒否する`, async t => {
  const f = createFixture(t); const a = await createApiFixture(t, f); const writer = new DatabaseSync(f.path);
  let sent = 0;
  t.mock.method(a.api.runner, 'request', async (request: RunnerRequest) => { sent++; return { type: 'res' as const, cmd_id: request.cmd_id, ok: true, result: {} }; });
  try {
    if (failure === 'busy') writer.exec('BEGIN IMMEDIATE');
    else t.mock.method(SendWatch.prototype, 'begin', () => { throw new Error('Injected failure'); });
    const ack = await a.command('send', 'send', { runId: 'root', input: { text: 'Next step' } });
    assert.equal(ack.ok, false); assert.equal(sent, 0);
  } finally { if (failure === 'busy') writer.exec('ROLLBACK'); writer.close(); await a.api.close(); }
});

test('本文の保持期限後も cmd_id の墓標を残し、再送せず異なる内容を衝突にする', t => {
  const f = createFixture(t); record(f);
  const captured = f.watch.capture(CONVERSATION, NOW);
  const later = NOW + 8 * 24 * 60 * 60_000;
  f.watch.check(later);
  assert.equal(f.watch.list().length, 0);
  assert.equal(JSON.stringify(f.db.prepare('SELECT data FROM api_delivery_operations').all()).includes('Next step'), false);
  assert.equal(f.watch.begin('send', CONVERSATION, 'Next step', captured), false);
  const reopened = new SendWatch(f.path); t.after(() => reopened.close());
  assert.equal(reopened.begin('send', CONVERSATION, 'Different', { ...captured, sent_ts: new Date(later).toISOString() }), false);
  reopened.check(later);
  assert.equal(reopened.decision('send')?.reason, 'cmd_id_conflict');
});

test('送出後の永続化が失敗しても同じ cmd_id をもう一度実行せず Unconfirmed にする', async t => {
  const f = createFixture(t); const a = await createApiFixture(t, f);
  let sent = 0;
  t.mock.method(a.api.runner, 'request', async (request: RunnerRequest) => { sent++; return { type: 'res' as const, cmd_id: request.cmd_id, ok: true, result: {} }; });
  const phase = SendWatch.prototype.phase;
  t.mock.method(SendWatch.prototype, 'phase', function (this: SendWatch, ...[id, value, at]: Parameters<SendWatch['phase']>) {
    if (value === 'emitted') throw new Error('Injected failure after write');
    return phase.call(this, id, value, at);
  });
  try {
    const payload = { runId: 'root', input: { text: 'Next step' } };
    await a.command('send', 'send', payload);
    await a.command('send', 'send', payload);
    assert.equal(sent, 1);
    t.mock.timers.setTime(NOW + SEND_WATCH_TIMEOUT_MS);
    await delay(550);
    assert.ok(a.frames.some(frame => frame.type === 'send_watches' && frame.rows.some((row: any) => row.decision.display === 'Unconfirmed')));
  } finally { await a.api.close(); }
});

test('同じ cmd_id の端末世代が変わった再提示も対象の衝突として残す', t => {
  const f = createFixture(t); record(f);
  assert.equal(f.watch.begin('send', CONVERSATION, 'Next step', f.watch.capture(CONVERSATION, NOW, 'new-terminal')), false);
  assert.equal(f.decide().reason, 'cmd_id_conflict');
});

test('runner への送信対象は表示上の最新 run ではなく要求した run に固定する', t => {
  const f = createFixture(t);
  const original = f.watch.capture(CONVERSATION, NOW, 'runner', 'root').target;
  f.append('run.created', 'run:new', { conversation_id: CONVERSATION, generation: 2, started_ts: new Date(NOW + 1000).toISOString() }, NOW + 1000);
  f.feed.refresh(NOW + 1000);
  assert.notEqual(f.watch.capture(CONVERSATION, NOW + 1000, 'runner').target, original);
  assert.equal(f.watch.capture(CONVERSATION, NOW + 1000, 'runner', 'root').target, original);
});

test('受付の後で会話と run の別名が解決しても、同じ start の再提示を衝突にしない', t => {
  const f = createFixture(t);
  const captured = f.watch.capture('c-new', NOW, 'runner', 'r-new');
  assert.equal(captured.target, JSON.stringify(['c-new', 'r-new', 'runner']));
  assert.equal(f.watch.begin('start', 'c-new', 'hello', captured), true);
  f.append('run.created', 'run:r-new', { conversation_id: 'c-new', generation: 1, state: 'starting', started_ts: new Date(NOW + 1).toISOString() }, NOW + 1);
  f.append('conversation.created', 'conversation:c-new', { provider: 'claude', native_id: 'native-new', origin: 'managed', type: 'interactive', history_format: 'jsonl' }, NOW + 1);
  f.feed.refresh(NOW + 1);
  const replay = f.watch.capture('c-new', NOW + 2, 'runner', 'r-new');
  assert.notEqual(replay.target, captured.target);
  assert.equal(f.watch.begin('start', 'c-new', 'hello', replay), false);
  assert.notEqual(f.decide('start', NOW + 2).reason, 'cmd_id_conflict');
  assert.deepEqual(f.watch.history(JSON.stringify(['claude', 'native-new'])).map(row => row.id), ['start']);
  assert.equal(f.watch.begin('start', 'c-new', 'other', f.watch.capture('c-new', NOW + 3, 'runner', 'r-new')), false);
  assert.equal(f.decide('start', NOW + 3).reason, 'cmd_id_conflict');
});

for (const state of ['failed', 'closed']) test(`旧い ${state} の baseline_seq と message_id を移行し、再起動でも配達を保つ`, t => {
  const f = createFixture(t);
  const sent = Date.parse('2026-10-14T09:08:58.299Z');
  t.mock.timers.setTime(sent);
  f.db.prepare("UPDATE sqlite_sequence SET seq = 301133 WHERE name = 'facts'").run();
  f.append('run.updated', 'run:root', { model: 'before-send' }, sent);
  const baseline = f.watch.capture(CONVERSATION, sent).baseline_seq;
  assert.equal(baseline, 301134);
  f.append('run.updated', 'run:root', { model: 'after-send' }, sent);
  const message = JSON.stringify(['claude', '88548f43-087b-4425-9cd0-61bbb2b6bc54']);
  addMessage(f, message, '<bash-input> echo delivered</bash-input>', sent + 1000);
  f.db.exec('CREATE TABLE api_send_watches (id TEXT PRIMARY KEY, conversation_id TEXT, body TEXT, sent_ts TEXT, baseline_seq INTEGER, state TEXT, message_id TEXT, attachments TEXT)');
  f.db.prepare('INSERT INTO api_send_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('legacy', CONVERSATION, '! echo delivered', new Date(sent).toISOString(), baseline, state, state === 'closed' ? message : null, '[]');
  for (let i = 0; i < 2; i++) {
    const watch = new SendWatch(f.path);
    watch.check(sent + SEND_WATCH_TIMEOUT_MS);
    const row = watch.list().find(row => row.id === 'legacy')!;
    assert.equal(row.baseline_seq, baseline); assert.equal(row.message_id, message);
    assert.equal(watch.decision('legacy')!.display, state === 'closed' ? 'Delivered' : 'Likely delivered');
    assert.equal(watch.decision('legacy')!.resendAutomatically, false);
    watch.close();
    if (i === 0) {
      const data = JSON.parse(String(f.db.prepare("SELECT data FROM api_delivery_operations WHERE id = 'legacy'").get()!.data));
      data.baseline_seq = 301999; delete data.message_id;
      f.db.prepare("UPDATE api_delivery_operations SET data = ? WHERE id = 'legacy'").run(JSON.stringify(data));
    }
  }
});

test('他接続のコミットで既に読んだ受信を結合し直さず、後着の競合入力は再評価する', t => {
  const f = createFixture(t); record(f); addMessage(f, 'first', 'Next step');
  assert.equal(f.decide('send', NOW + 3).display, 'Likely delivered');
  const prepare = DatabaseSync.prototype.prepare; let joins = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (sql.includes('JOIN messages') || sql.includes('FROM messages')) joins++;
    return prepare.call(this, sql);
  });
  f.db.exec('CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (1)');
  assert.equal(f.decide('send', NOW + 3).display, 'Likely delivered'); assert.equal(joins, 0);
  addMessage(f, 'second', 'Next step', NOW + 2);
  assert.equal(f.decide('send', NOW + 3).reason, 'ambiguous_candidates');
});

test('差分照合は所属の後着・訂正・再構築でも受信集合を更新する', t => {
  const f = createFixture(t); record(f);
  f.append('message.created', 'message:late-link', { role: 'user', body: 'Next step', body_state: 'stored', version: 1 }, NOW + 1);
  f.feed.refresh(NOW + 2); assert.equal(f.decide('send', NOW + 2).value, 'emitted');
  f.append('message_membership.created', 'message_membership:late-link', { message_id: 'late-link', conversation_id: CONVERSATION, active: true }, NOW + 1);
  f.feed.refresh(NOW + 3); assert.equal(f.decide('send', NOW + 3).value, 'received_candidate');
  f.append('message.corrected', 'message:late-link', { role: 'user', body: 'Different', body_state: 'stored', version: 2 }, NOW + 2,
    f.ledger.readSince(0, Number.MAX_SAFE_INTEGER).find(fact => fact.subject === 'message:late-link')!.fact_id);
  f.feed.refresh(NOW + 4); assert.equal(f.decide('send', NOW + 4).value, 'emitted');
  f.service.rebuild(); f.feed.refresh(NOW + 4); assert.equal(f.decide('send', NOW + 4).value, 'emitted');
});
