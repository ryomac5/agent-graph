import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { JsonValue } from '../../core/src/ledger/facts.ts';
import { createTargetService } from '../src/remote/index.ts';
import { RunnerClient, type RunnerEvent, type RunnerRequest, type RunnerResponse } from '../src/runner-client.ts';
import { openObservationService } from '../src/service/index.ts';
import type { RunnerTerminalInfo, RunnerPtySpawnRequest } from '../src/terminal/runner-pty.ts';
import { startWebSocketServer } from '../src/ws/index.ts';

type Api = Awaited<ReturnType<typeof startWebSocketServer>>;
interface Ack { type: string; cmd_id: string; ok: boolean; result: { terminalId: string; scrollback?: string }; error?: string }
const TIMEOUT_MS = 5000;
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!check()) { assert.ok(Date.now() < deadline, 'Timed out'); await delay(10); }
}
class FakeRunner {
  requests: RunnerRequest[] = [];
  terminals: RunnerTerminalInfo[] = [];
  responses = new Map<string, RunnerResponse>();
  holdSpawnReply = false;
  releaseSpawn?: () => void;
  async request(request: RunnerRequest): Promise<RunnerResponse> {
    this.requests.push(structuredClone(request));
    let response = this.responses.get(request.cmd_id);
    if (!response) {
      let result: JsonValue = {};
      if (request.command === 'status') result = { capabilities: { terminals: true } };
      if (request.command === 'terminal.list') result = JSON.parse(JSON.stringify(this.terminals));
      if (request.command === 'terminal.spawn') {
        const input = request.payload as unknown as RunnerPtySpawnRequest;
        const info = { terminalId: `terminal-${this.terminals.length}`, pid: 1000 + this.terminals.length,
          meta: input.meta, startedAt: '2026-10-17T00:00:00.000Z', scrollback: 'still running' };
        this.terminals.push(info);
        result = { terminalId: info.terminalId, pid: info.pid };
      }
      response = { type: 'res', cmd_id: request.cmd_id, ok: true, result };
      this.responses.set(request.cmd_id, response);
    }
    if (this.holdSpawnReply && request.command === 'terminal.spawn') {
      await new Promise<void>(resolve => { this.releaseSpawn = resolve; });
    }
    return response;
  }
}
class BrowserSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  messages: Ack[] = [];
  send(data: string) { this.messages.push(JSON.parse(data)); }
  terminate() { this.emit('close'); }
  command(cmd_id: string, command = 'session.launch', payload: unknown = { projectId: 'p', provider: 'claude' }) {
    this.emit('message', Buffer.from(JSON.stringify({ type: 'cmd', cmd_id, command, payload })), false);
  }
  async ack(cmd_id: string) {
    await waitUntil(() => this.messages.some(message => message.type === 'ack' && message.cmd_id === cmd_id));
    return this.messages.splice(this.messages.findIndex(message => message.type === 'ack' && message.cmd_id === cmd_id), 1)[0];
  }
}
async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ag-ws-launch-'));
  const service = openObservationService({ dbPath: join(directory, 'ledger.db') });
  const runnerPath = join(directory, 'runner.sock');
  const runner = new FakeRunner();
  const connections: RunnerClient[] = [];
  // 通信だけを置き換え、WS のコマンド処理と sessionHosts は実装を通す。
  const prototype = RunnerClient.prototype as unknown as { connect(): void; path: string; connectionGeneration: number };
  t.mock.method(prototype, 'connect', function (this: typeof prototype) {
    assert.equal(this.path, runnerPath);
    this.connectionGeneration++;
    connections.push(this as unknown as RunnerClient);
  });
  t.mock.getter(RunnerClient.prototype, 'available', () => true);
  t.mock.method(RunnerClient.prototype, 'request', (request: RunnerRequest) => runner.request(request));
  let failListen = false;
  t.mock.method(Server.prototype, 'listen', function (this: Server, _port: number, _host: string, callback: () => void) {
    if (failListen) queueMicrotask(() => this.emit('error', Object.assign(new Error('Address in use'), { code: 'EADDRINUSE' })));
    else callback();
    return this;
  });
  t.mock.method(Server.prototype, 'address', () => ({ address: '127.0.0.1', family: 'IPv4', port: 7421 }));
  t.mock.method(Server.prototype, 'close', function (this: Server, callback?: () => void) { callback?.(); return this; });
  let wss!: WebSocketServer;
  const on = WebSocketServer.prototype.on;
  t.mock.method(WebSocketServer.prototype, 'on', function (this: WebSocketServer, event: string, listener: (...args: any[]) => void) {
    if (event === 'connection') wss = this;
    return on.call(this, event, listener);
  });
  const servers = new Set<Api>();
  const browsers: BrowserSocket[] = [];
  async function close(api: Api) { if (servers.delete(api)) await api.close(); }
  t.after(async () => {
    runner.releaseSpawn?.();
    for (const browser of browsers) browser.terminate();
    for (const api of servers) await close(api);
    service.close(); await rm(directory, { recursive: true, force: true });
  });
  async function start() {
    const api = await startWebSocketServer(service, { port: 0, runnerPath,
      sessionHosts: { sessionsDirectory: join(directory, 'sessions'), listProcesses: async () => [],
        targets: createTargetService(async () => directory),
      } });
    servers.add(api);
    return api;
  }
  function connect() {
    const browser = new BrowserSocket(); browsers.push(browser);
    wss.emit('connection', browser);
    browser.emit('message', Buffer.from(JSON.stringify({ type: 'hello', seq: 0 })), false);
    return browser;
  }
  return { runner, connections, start, close, connect, failListen() { failListen = true; },
    publish(event: RunnerEvent) {
      const client = connections.at(-1) as unknown as { onEvent(event: RunnerEvent): void };
      client.onEvent(event);
    },
  };
}

for (const provider of ['claude', 'codex']) test(`${provider}: duplicate launch and replay after API restart spawn only one terminal; close never kills`, async t => {
  const f = await createFixture(t);
  let api = await f.start();
  let browser = f.connect();
  const payload = { projectId: 'p', provider };
  browser.command('launch-1', 'session.launch', payload);
  browser.command('launch-1', 'session.launch', payload);
  const first = await browser.ack('launch-1');
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(await browser.ack('launch-1'), first);
  await f.close(api);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
  api = await f.start(); browser = f.connect();
  browser.command('launch-1', 'session.launch', payload);
  assert.deepEqual(await browser.ack('launch-1'), first);
  browser.command('attach', 'terminal.attach', { terminalId: first.result.terminalId });
  assert.deepEqual((await browser.ack('attach')).result, { terminalId: first.result.terminalId, scrollback: 'still running' });
  f.publish({ type: 'evt', terminal: { terminalId: first.result.terminalId, output: 'new output' } });
  assert.deepEqual(browser.messages.at(-1), { type: 'terminal', event: 'output', terminalId: first.result.terminalId, data: 'new output' });
  assert.equal(f.runner.terminals.length, 1);
  const spawns = f.runner.requests.filter(request => request.command === 'terminal.spawn');
  assert.equal(spawns.length, 2);
  assert.equal(spawns[0].cmd_id, spawns[1].cmd_id);
  browser.command('write', 'terminal.input', { terminalId: first.result.terminalId, data: 'hello' });
  assert.equal((await browser.ack('write')).ok, true);
  await waitUntil(() => f.runner.requests.some(request => request.command === 'terminal.write'));
  assert.equal(f.connections.length, 2);
  await f.close(api);
  const messages = browser.messages.length;
  f.publish({ type: 'evt', terminal: { terminalId: first.result.terminalId, output: 'after detach' } });
  assert.equal(browser.messages.length, messages);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
});

test('close while spawn awaits its reply detaches; restart retries the saved runner response', async t => {
  const f = await createFixture(t);
  let api = await f.start();
  let browser = f.connect();
  f.runner.holdSpawnReply = true; browser.command('lost-launch');
  await waitUntil(() => f.runner.terminals.length === 1);
  await f.close(api);
  f.runner.holdSpawnReply = false; f.runner.releaseSpawn?.();
  api = await f.start(); browser = f.connect();
  browser.command('lost-launch');
  const ack = await browser.ack('lost-launch');
  assert.equal(ack.ok, true, ack.error);
  assert.equal(ack.result.terminalId, f.runner.terminals[0].terminalId);
  assert.equal(f.runner.terminals.length, 1);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
});

test('WebSocket startup failure leaves existing runner terminals alive', async t => {
  const f = await createFixture(t);
  await f.start();
  const browser = f.connect();
  browser.command('launch'); assert.equal((await browser.ack('launch')).ok, true);
  f.failListen();
  await assert.rejects(f.start(), { code: 'EADDRINUSE' });
  assert.equal(f.runner.terminals.length, 1);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
});

test('concurrent browser launches keep distinct runner command IDs', async t => {
  const f = await createFixture(t);
  await f.start();
  const browser = f.connect();
  browser.command('launch-a'); browser.command('launch-b');
  const [a, b] = await Promise.all([browser.ack('launch-a'), browser.ack('launch-b')]);
  assert.equal(a.ok, true, a.error); assert.equal(b.ok, true, b.error);
  assert.notEqual(a.result.terminalId, b.result.terminalId);
  assert.equal(new Set(f.runner.requests.filter(request => request.command === 'terminal.spawn').map(request => request.cmd_id)).size, 2);
});
