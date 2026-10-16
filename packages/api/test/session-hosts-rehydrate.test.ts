import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import type { JsonValue } from '../../core/src/ledger/facts.ts';
import type { RunnerEvent, RunnerRequest, RunnerResponse } from '../src/runner-client.ts';
import { createSessionHosts, type HostOptions } from '../src/terminal/hosts.ts';
import type { RunnerTerminalInfo, RunnerPtySpawnRequest } from '../src/terminal/runner-pty.ts';
import { MODEL_PANEL, promptFrame } from './terminal-screen-fixture.ts';

const SESSION = '12345678-1234-1234-1234-123456789abc';
const conversationId = JSON.stringify(['claude', SESSION]);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function createInfo(terminalId = 'runner-terminal'): RunnerTerminalInfo {
  return { terminalId, pid: 1000, startedAt: '2026-10-17T00:00:00.000Z', scrollback: promptFrame(),
    meta: { sessionHost: true, provider: 'claude', projectId: 'p', cwd: '/repo', target: { kind: 'local' }, described: true, launchModel: 'haiku' } };
}
class FakeRunner {
  available = true;
  connectionGeneration = 1;
  terminals = true;
  infos: RunnerTerminalInfo[] = [];
  requests: RunnerRequest[] = [];
  onEvent: (event: RunnerEvent) => void = () => {};
  beforeRequest?: (request: RunnerRequest) => Promise<void>;
  async request(request: RunnerRequest): Promise<RunnerResponse> {
    this.requests.push(structuredClone(request));
    await this.beforeRequest?.(request);
    if (!this.available) return { type: 'res', cmd_id: request.cmd_id, ok: false, error: 'Runner unavailable' };
    let result: JsonValue = {};
    if (request.command === 'status') result = { capabilities: this.terminals ? { terminals: true } : {} };
    if (request.command === 'terminal.list') result = JSON.parse(JSON.stringify(this.infos));
    if (request.command === 'terminal.spawn') {
      const input = request.payload as unknown as RunnerPtySpawnRequest;
      const info = { ...createInfo('runner-' + this.infos.length), meta: input.meta };
      this.infos.push(info);
      result = { terminalId: info.terminalId, pid: info.pid };
    }
    if (request.command === 'terminal.kill') this.infos = this.infos.filter(info => info.terminalId !== (request.payload as { terminalId: string }).terminalId);
    return { type: 'res', cmd_id: request.cmd_id, ok: true, result };
  }
  close() { this.onEvent = () => {}; }
  output(data: string) {
    this.infos[0].scrollback += data;
    this.onEvent({ type: 'evt', terminal: { terminalId: this.infos[0].terminalId, output: data } });
  }
}
async function createFixture(t: TestContext, options: HostOptions = {}, runner = new FakeRunner()) {
  const directory = await mkdtemp(join(tmpdir(), 'ag-hosts-rehydrate-'));
  const services: ReturnType<typeof createSessionHosts>[] = [];
  const start = () => {
    const service = createSessionHosts(async () => '/repo', {
      createRunnerClient: onEvent => { runner.onEvent = onEvent; return runner; },
      sessionsDirectory: directory, listProcesses: async () => [{ pid: 2000, ppid: 1000 }],
      attachments: { directory: join(directory, 'attachments') }, quietMs: 0, warmupMs: 0, submitDelayMs: 0,
      ...options, targetOptions: { cache: join(directory, 'cache'), settingsPath: join(directory, 'ssh.toml'), ...options.targetOptions },
    });
    services.push(service);
    return service;
  };
  t.after(async () => { for (const service of services) service.close(); await rm(directory, { recursive: true, force: true }); });
  return { runner, directory, start };
}
const handle = (service: ReturnType<typeof createSessionHosts>, command: string, payload: unknown = {}) => service.handle(command, payload, () => {});

test('API restart rehydrates runner identity, metadata, descendant session and scrollback without spawning or killing', async t => {
  const f = await createFixture(t);
  let service = f.start();
  const launched = await handle(service, 'session.launch', { projectId: 'p', provider: 'claude', model: 'haiku', target: { kind: 'local' } }) as { terminalId: string };
  await writeFile(join(f.directory, '2000.json'), JSON.stringify({ pid: 2000, sessionId: SESSION }));
  f.runner.output('before restart');
  service.close();
  f.runner.infos[0].scrollback += ' while detached';
  service = f.start();
  const listed = await handle(service, 'session.hosts') as { hosts: { terminalId: string; conversationId: string; launchModel: string; startedAt: string }[] };
  assert.equal(listed.hosts[0].terminalId, launched.terminalId);
  assert.equal(listed.hosts[0].conversationId, conversationId);
  assert.equal(listed.hosts[0].launchModel, 'haiku');
  assert.equal(listed.hosts[0].startedAt, f.runner.infos[0].startedAt);
  assert.deepEqual(await handle(service, 'terminal.attach', { terminalId: launched.terminalId }), { terminalId: launched.terminalId, scrollback: f.runner.infos[0].scrollback });
  await handle(service, 'session.send', { conversationId, text: 'after restart' });
  assert.deepEqual(f.runner.requests.filter(request => request.command === 'terminal.write').map(request => request.payload),
    ['\x15', '\x1b[200~after restart\x1b[201~', '\r'].map(data => ({ terminalId: launched.terminalId, data })));
  assert.equal(f.runner.requests.filter(request => request.command === 'terminal.spawn').length, 1);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
});

test('rehydrated screen rejects messages into a restored interactive panel', async t => {
  const f = await createFixture(t);
  f.runner.infos = [{ ...createInfo(), scrollback: MODEL_PANEL }];
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const service = f.start();
  await handle(service, 'session.hosts');
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'not a selection' }), /Terminal is not ready/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.write'), false);
});

test('reconnect polling rebuilds the screen, preserves browser subscriptions and routes to the same terminal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await createFixture(t);
  f.runner.infos = [createInfo()];
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const service = f.start();
  await handle(service, 'session.hosts');
  const events: unknown[] = [];
  await service.handle('terminal.attach', { terminalId: 'runner-terminal' }, event => events.push(event));
  f.runner.available = false;
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'offline' }), /Runner unavailable/);
  f.runner.infos[0].scrollback = MODEL_PANEL;
  f.runner.available = true;
  f.runner.connectionGeneration++;
  t.mock.timers.tick(500);
  await service.rehydrate();
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'panel' }), /Terminal is not ready/);
  f.runner.output(promptFrame());
  assert.ok(events.length > 0);
  await handle(service, 'session.send', { conversationId, text: 'reconnected' });
  assert.equal(f.runner.requests.at(-1)?.command, 'terminal.write');
  assert.deepEqual(f.runner.requests.at(-1)?.payload, { terminalId: 'runner-terminal', data: '\r' });
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.spawn' || request.command === 'terminal.kill'), false);
});

test('discovery in progress fails explicitly, then newly discovered sessions can receive sends', async t => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = await createFixture(t, { listProcesses: async () => { await pending; return []; } });
  f.runner.infos = [createInfo()];
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const service = f.start();
  await tick();
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'early' }), /Host discovery pending; retry session.send/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.write'), false);
  finish();
  await service.rehydrate();
  await handle(service, 'session.send', { conversationId, text: 'ready' });
});

test('reconnect rejects sends while cleared hosts are being rediscovered, then sends to the same runner terminal', async t => {
  let pending: Promise<void> | undefined;
  let entered!: () => void;
  const f = await createFixture(t, { listProcesses: async () => {
    if (pending) { entered(); await pending; }
    return [];
  } });
  f.runner.infos = [createInfo()];
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const service = f.start();
  await service.rehydrate();
  let release!: () => void;
  pending = new Promise<void>(resolve => { release = resolve; });
  const discovering = new Promise<void>(resolve => { entered = resolve; });
  f.runner.connectionGeneration++;
  const restoring = service.rehydrate();
  try {
    await discovering;
    assert.equal(service.hasTerminal('runner-terminal'), true);
    await assert.rejects(handle(service, 'session.send', { conversationId, text: 'during reconnect' }), /^Error: Host discovery pending; retry session.send$/);
    assert.equal(f.runner.requests.some(request => request.command === 'terminal.write'), false);
  } finally { release(); await restoring; }
  await handle(service, 'session.send', { conversationId, text: 'after reconnect' });
  assert.deepEqual(f.runner.requests.filter(request => request.command === 'terminal.write').map(request => request.payload),
    ['\x15', '\x1b[200~after reconnect\x1b[201~', '\r'].map(data => ({ terminalId: 'runner-terminal', data })));
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.spawn' || request.command === 'terminal.kill'), false);
});

for (const unavailable of ['connection', 'capability'] as const) test(`${unavailable}: launch fails with Runner unavailable and never falls back to local spawn`, async t => {
  const f = await createFixture(t);
  if (unavailable === 'connection') f.runner.available = false;
  else f.runner.terminals = false;
  const service = f.start();
  await assert.rejects(handle(service, 'session.launch', { projectId: 'p', provider: 'claude' }), /^Error: Runner unavailable$/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.spawn'), false);
  f.runner.available = true; f.runner.terminals = true;
  await handle(service, 'session.launch', { projectId: 'p', provider: 'claude' });
  assert.equal(f.runner.infos.length, 1);
});

test('close detaches even while spawn awaits its reply; only terminal.close kills', async t => {
  const f = await createFixture(t);
  const service = f.start();
  await service.rehydrate();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.runner.beforeRequest = async request => { if (request.command === 'terminal.spawn') await pending; };
  const launch = handle(service, 'session.launch', { projectId: 'p', provider: 'claude' });
  await tick();
  service.close(); finish();
  await assert.rejects(launch, /closed/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
  f.runner.beforeRequest = undefined;
  const restored = f.start();
  await restored.rehydrate();
  const notify = () => {};
  await restored.handle('terminal.attach', { terminalId: 'runner-0' }, notify);
  await restored.handle('terminal.close', { terminalId: 'runner-0' }, notify);
  await tick();
  assert.equal(f.runner.requests.filter(request => request.command === 'terminal.kill').length, 1);
  assert.equal(restored.hasTerminal('runner-0'), false);
});

test('simultaneous resume requests reserve identity before asynchronous spawn', async t => {
  const f = await createFixture(t);
  const service = f.start();
  await service.rehydrate();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  f.runner.beforeRequest = async request => { if (request.command === 'terminal.spawn') await pending; };
  const payload = { projectId: 'p', provider: 'claude', resume: SESSION };
  const first = handle(service, 'session.launch', payload);
  await tick();
  await assert.rejects(handle(service, 'session.launch', payload), /Session already hosted/);
  finish(); await first;
  assert.equal(f.runner.requests.filter(request => request.command === 'terminal.spawn').length, 1);
});

for (const provider of ['claude', 'codex'] as const) test(`SSH ${provider} rehydration restarts its mirror and restores the remote PID from scrollback`, async t => {
  const streams: { killed: boolean }[] = [];
  const runner = new FakeRunner();
  runner.infos = [{ ...createInfo(), scrollback: '\x1b]777;agent-graph-pid=4321\x07' + promptFrame(provider), meta: {
    ...createInfo().meta, provider, target: { kind: 'ssh', id: 'server' },
    connection: { id: 'server', name: 'Server', destination: 'dev@host', projects: [{ projectId: 'p', path: '/repo' }] },
  } }];
  const commands: string[] = [];
  const f = await createFixture(t, { targetOptions: {
    execute: async (file, args) => {
      assert.equal(file, 'ssh');
      const command = args.at(-1)!; commands.push(command);
      if (command.startsWith('cd')) return '/repo';
      if (command.startsWith('ps')) return '4321 1';
      if (command.startsWith('lsof')) return `n/remote/rollout-test-${SESSION}.jsonl`;
      if (command.startsWith('head')) return JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: '/repo' } });
      if (command.startsWith('find')) return `/remote/${SESSION}.jsonl`;
      return `\x1e${Date.now() / 1000}\n${JSON.stringify({ pid: 4321, sessionId: SESSION, cwd: '/repo' })}`;
    },
    spawnStream: (() => {
      const stream = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill() { this.killed = true; } });
      streams.push(stream); return stream;
    }) as unknown as typeof spawn,
  } }, runner);
  let service = f.start();
  await service.rehydrate();
  assert.equal(streams.length, 1);
  service.close();
  assert.equal(streams[0].killed, true);
  service = f.start();
  const listed = await handle(service, 'session.hosts') as { hosts: { conversationId: string; terminalId: string; disconnected: boolean }[] };
  assert.equal(streams.length, 2);
  assert.equal(listed.hosts[0].conversationId, JSON.stringify([provider, SESSION]));
  assert.equal(listed.hosts[0].terminalId, 'runner-terminal');
  assert.equal(listed.hosts[0].disconnected, false);
  assert.ok(commands.some(command => provider === 'codex' ? command.startsWith('lsof') && command.includes('4321') : command.startsWith('ps')));
  assert.equal(runner.requests.some(request => request.command === 'terminal.spawn' || request.command === 'terminal.kill'), false);
});

test('a failed list retries after reconnect, and missing terminals disappear without a kill', async t => {
  const f = await createFixture(t);
  f.runner.infos = [createInfo()];
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const service = f.start();
  await service.rehydrate();
  f.runner.connectionGeneration++;
  f.runner.beforeRequest = async request => { if (request.command === 'terminal.list') throw new Error('list failed'); };
  await assert.rejects(service.rehydrate(), /list failed/);
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'not yet' }), /Host discovery pending/);
  await tick();
  f.runner.beforeRequest = undefined;
  f.runner.infos = [];
  await service.rehydrate();
  assert.equal(service.hasTerminal('runner-terminal'), false);
  await assert.rejects(handle(service, 'session.send', { conversationId, text: 'gone' }), /no_host/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.kill'), false);
});

test('rehydrated hosts count toward the limit before an asynchronous launch', async t => {
  const f = await createFixture(t);
  f.runner.infos = Array.from({ length: 8 }, (_, index) => ({ ...createInfo('existing-' + index), pid: 1000 + index }));
  const service = f.start();
  await assert.rejects(handle(service, 'session.launch', { projectId: 'p', provider: 'claude' }), /Terminal limit reached/);
  assert.equal(f.runner.requests.some(request => request.command === 'terminal.spawn'), false);
});

test('spawn and rehydrate share runner IDs without duplicate subscriptions or double-counted opening slots', async t => {
  const f = await createFixture(t);
  const service = f.start();
  await service.rehydrate();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.runner.beforeRequest = async request => { if (request.command === 'terminal.spawn') await pending; };
  const launches = Array.from({ length: 8 }, () => handle(service, 'session.launch', { projectId: 'p', provider: 'claude' }));
  await tick();
  const rehydrated = service.rehydrate();
  release();
  const results = await Promise.all(launches) as { terminalId: string }[];
  await rehydrated;
  assert.equal(new Set(results.map(result => result.terminalId)).size, 8);
  assert.ok(results.every(result => service.hasTerminal(result.terminalId)));
  await assert.rejects(handle(service, 'session.launch', { projectId: 'p', provider: 'claude' }), /Terminal limit reached/);
  const events: unknown[] = [];
  await service.handle('terminal.attach', { terminalId: results[0].terminalId }, event => events.push(event));
  f.runner.output('one event');
  assert.equal(events.length, 1);
});
