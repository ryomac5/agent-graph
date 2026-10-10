import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { WebSocket } from 'ws';
import { createFilesApi } from '../src/files/index.ts';
import { openObservationService } from '../src/service/index.ts';
import { startWebSocketServer } from '../src/ws/index.ts';
import { startStaticServer } from '../src/static/index.ts';
import { createTerminalSession, type TerminalNotification } from '../src/terminal/index.ts';

const execute = promisify(execFile);
async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ag-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(root);
  await execute('git', ['-C', root, 'init']);
  const service = openObservationService({ dbPath: join(directory, 'ledger.db') });
  t.after(() => service.close());
  service.ledger.append({ source: 'ui', source_event_id: 'register', kind: 'project.created', subject: 'project:terminal',
    source_ts: '2026-10-10T00:00:00Z', confidence: 'confirmed', payload: {
      repository_id: 'terminal-project', root_path: root, display_name: 'Terminal', name_prefix: 'Terminal', state: 'registered',
    } });
  service.catchUp();
  return { directory, root, service, request: { projectId: 'terminal-project', cols: 80, rows: 24 } };
}
async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Terminal notification timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function skipSandbox(t: TestContext, error: unknown): boolean {
  if (error instanceof Error && 'code' in error && error.code === 'EPERM'
    && 'syscall' in error && ['listen', 'chmod'].includes(String(error.syscall))) {
    t.skip(`sandbox blocks ${error.syscall}`);
    return true;
  }
  return false;
}

test('real node-pty output, resize, close, ownership, limit and disconnect', { timeout: 15000 }, async t => {
  const { service, request } = await createFixture(t);
  const db = new DatabaseSync(service.dbPath, { readOnly: true });
  t.after(() => db.close());
  const files = createFilesApi(db);
  const messages: TerminalNotification[] = [];
  const session = createTerminalSession(files.selectRoot, message => messages.push(message));
  const other = createTerminalSession(files.selectRoot, () => assert.fail('Output sent to other session'));
  t.after(() => { session.close(); other.close(); });
  let opened: { terminalId: string; cwd: string; shell: string };
  try { opened = await session.handle('terminal.open', request) as typeof opened; }
  catch (error) { if (skipSandbox(t, error)) return; throw error; }
  assert.equal(opened.cwd, await files.selectRoot(request));
  assert.equal(opened.shell, process.env.SHELL || '/bin/zsh');
  const output = () => messages.filter(message => message.event === 'output' && message.terminalId === opened.terminalId)
    .map(message => message.event === 'output' ? message.data : '').join('');
  await session.handle('terminal.input', { terminalId: opened.terminalId, data: 'echo agent-graph-pty\r' });
  await waitUntil(() => output().split('agent-graph-pty').length >= 3);
  await session.handle('terminal.resize', { terminalId: opened.terminalId, cols: 93, rows: 31 });
  await session.handle('terminal.input', { terminalId: opened.terminalId, data: 'stty size\r' });
  await waitUntil(() => /31\s+93/.test(output()));
  await assert.rejects(other.handle('terminal.input', { terminalId: opened.terminalId, data: 'no' }), /Unknown terminal/);
  await session.handle('terminal.close', { terminalId: opened.terminalId });
  await waitUntil(() => messages.some(message => message.event === 'exit' && message.terminalId === opened.terminalId));
  const openedIds = await Promise.all(Array.from({ length: 8 }, () => session.handle('terminal.open', request)));
  await assert.rejects(session.handle('terminal.open', request), /Terminal limit reached/);
  const pids: number[] = [];
  let pidOutput = "";
  const tracking = createTerminalSession(files.selectRoot, message => {
    if (message.event === 'output') {
      pidOutput += message.data;
      const match = /PTY_PID=(\d+)\r?\n/.exec(pidOutput);
      if (match) pids.push(Number(match[1]));
    }
  });
  t.after(() => tracking.close());
  const tracked = await tracking.handle('terminal.open', request) as typeof opened;
  await tracking.handle('terminal.input', { terminalId: tracked.terminalId, data: 'echo PTY_PID=$$\r' });
  await waitUntil(() => pids.length > 0);
  tracking.close();
  await waitUntil(() => { try { process.kill(pids[0], 0); return false; } catch { return true; } });
  assert.equal(openedIds.length, 8);
});

test('terminal notifications traverse static /ws and remain scoped to their connection', { timeout: 15000 }, async t => {
  const { directory, service, request } = await createFixture(t);
  let upstream: Awaited<ReturnType<typeof startWebSocketServer>>;
  try { upstream = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'missing.sock') }); }
  catch (error) { if (skipSandbox(t, error)) return; throw error; }
  t.after(() => upstream.close());
  const dist = join(directory, 'dist');
  await mkdir(dist); await writeFile(join(dist, 'index.html'), '<html></html>');
  const proxy = await startStaticServer({ port: 0, dist, upstream });
  t.after(() => proxy.close());
  const snapshot = await fetch(`${upstream.url}/snapshot?token=${upstream.token}`).then(response => response.json());
  async function connect() {
    const socket = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/ws?token=${upstream.token}`, { origin: proxy.url });
    t.after(() => socket.terminate());
    const frames: any[] = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation }));
    let sequence = 0;
    async function command(command: string, payload: unknown) {
      const cmd_id = `terminal-${++sequence}`;
      socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload }));
      await waitUntil(() => frames.some(frame => frame.type === 'ack' && frame.cmd_id === cmd_id));
      return frames.find(frame => frame.type === 'ack' && frame.cmd_id === cmd_id);
    }
    return { socket, frames, command };
  }
  const client = await connect();
  const other = await connect();
  const opened = await client.command('terminal.open', request);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const { terminalId } = opened.result;
  assert.equal((await client.command('terminal.input', { terminalId, data: 'echo agent-graph-pty\r' })).ok, true);
  const output = () => client.frames.filter(frame => frame.type === 'terminal' && frame.event === 'output').map(frame => frame.data).join('');
  await waitUntil(() => output().split('agent-graph-pty').length >= 3);
  assert.equal(other.frames.filter(frame => frame.type === 'terminal').length, 0);
  assert.equal((await other.command('terminal.close', { terminalId })).ok, false);
  await client.command('terminal.close', { terminalId });
  await waitUntil(() => client.frames.some(frame => frame.event === 'exit' && frame.terminalId === terminalId));
  const second = await client.command('terminal.open', request);
  await client.command('terminal.input', { terminalId: second.result.terminalId, data: `echo $$ > '${join(directory, 'pid')}'\r` });
  const { readFile } = await import('node:fs/promises');
  let pid = 0;
  await waitUntil(async () => {
    try { pid = Number(await readFile(join(directory, 'pid'), 'utf8')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    return pid > 0;
  });
  client.socket.terminate();
  await waitUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('terminal session enforces ownership, pending-open limit, env filtering and disconnect cleanup without PTYs', async t => {
  const { spawn } = await import('node-pty');
  const messages: TerminalNotification[] = [];
  const children: { killed: boolean; input: string[]; size: number[]; output: (data: string) => void; exit: (event: { exitCode: number; signal?: number }) => void }[] = [];
  const options: Parameters<typeof spawn>[2][] = [];
  const shells: { file: string; args: string[] | string }[] = [];
  const open: typeof spawn = (file, args, config) => {
    options.push(config);
    shells.push({ file, args });
    const child = { killed: false, input: [] as string[], size: [] as number[], output: (_data: string) => {}, exit: (_event: { exitCode: number; signal?: number }) => {} };
    children.push(child);
    return {
      write(data: string) { child.input.push(data); },
      resize(cols: number, rows: number) { child.size = [cols, rows]; },
      kill() { child.killed = true; queueMicrotask(() => child.exit({ exitCode: 0 })); },
      onData(callback: typeof child.output) { child.output = callback; return { dispose() {} }; },
      onExit(callback: typeof child.exit) { child.exit = callback; return { dispose() {} }; },
    } as unknown as ReturnType<typeof spawn>;
  };
  const originalSecret = process.env.AGENT_GRAPH_TEST_SECRET;
  process.env.AGENT_GRAPH_TEST_SECRET = 'internal-secret';
  t.after(() => {
    if (originalSecret === undefined) delete process.env.AGENT_GRAPH_TEST_SECRET;
    else process.env.AGENT_GRAPH_TEST_SECRET = originalSecret;
  });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const session = createTerminalSession(async request => { await blocked; return request.worktree ?? '/project'; }, message => messages.push(message), open);
  t.after(() => session.close());
  const request = { projectId: 'project', cols: 80, rows: 24 };
  const pending = Array.from({ length: 8 }, () => session.handle('terminal.open', request));
  await assert.rejects(session.handle('terminal.open', request), /Terminal limit/);
  release();
  const opened = await Promise.all(pending) as { terminalId: string; cwd: string; shell: string }[];
  const terminalId = opened[0].terminalId;
  assert.equal(opened[0].cwd, '/project');
  assert.deepEqual(shells[0], { file: process.env.SHELL || '/bin/zsh', args: ['-l'] });
  assert.equal(options[0]?.env?.TERM, 'xterm-256color');
  assert.equal(Object.keys(options[0]?.env ?? {}).some(key => key.startsWith('AGENT_GRAPH')), false);
  children[0].output('real-shaped-output');
  assert.deepEqual(messages[0], { type: 'terminal', event: 'output', terminalId, data: 'real-shaped-output' });
  await session.handle('terminal.input', { terminalId, data: 'input\r' });
  assert.deepEqual(children[0].input, ['input\r']);
  await session.handle('terminal.resize', { terminalId, cols: 91, rows: 32 });
  assert.deepEqual(children[0].size, [91, 32]);
  const other = createTerminalSession(async () => '/other', () => assert.fail('Foreign output'), open);
  t.after(() => other.close());
  await assert.rejects(other.handle('terminal.close', { terminalId }), /Unknown terminal/);
  await assert.rejects(session.handle('terminal.resize', { terminalId, cols: 0, rows: 32 }), /Invalid terminal size/);
  await session.handle('terminal.close', { terminalId });
  await waitUntil(() => messages.some(message => message.event === 'exit' && message.terminalId === terminalId));
  await assert.rejects(session.handle('terminal.input', { terminalId, data: 'gone' }), /Unknown terminal/);
  const tree = await session.handle('terminal.open', { ...request, worktree: '/selected-tree' }) as typeof opened[0];
  assert.equal(tree.cwd, '/selected-tree');
  session.close();
  assert.ok(children.every(child => child.killed));
  const count = messages.length;
  children[1].output('after disconnect');
  assert.equal(messages.length, count);
  await assert.rejects(session.handle('terminal.open', request), /connection closed/);
});

test('disconnect during root selection prevents spawning a terminal', async () => {
  let release!: (root: string) => void;
  const root = new Promise<string>(resolve => { release = resolve; });
  const session = createTerminalSession(() => root, () => assert.fail('Disconnected notification'), () => assert.fail('Disconnected spawn'));
  const pending = session.handle('terminal.open', { projectId: 'project', cols: 80, rows: 24 });
  session.close();
  release('/project');
  await assert.rejects(pending, /connection closed/);
});

test('hosted sessions survive WebSocket disconnect, replay commands once and attach on a new connection', async t => {
  const { directory, service } = await createFixture(t);
  const sessionId = '12345678-1234-1234-1234-123456789abc';
  const conversationId = JSON.stringify(['claude', sessionId]);
  let starts = 0;
  const writes: string[] = [];
  let output = (_data: string) => {};
  let exit = (_event: { exitCode: number }) => {};
  let killed = false;
  await writeFile(join(directory, '98765.json'), JSON.stringify({ pid: 98765, sessionId }));
  const { spawn } = await import('node-pty');
  const openTerminal: typeof spawn = () => {
    starts++;
    return { pid: 98765, write: (data: string) => writes.push(data), resize() {},
      kill() { killed = true; exit({ exitCode: 0 }); },
      onData(callback: typeof output) { output = callback; return { dispose() {} }; },
      onExit(callback: typeof exit) { exit = callback; return { dispose() {} }; },
    } as unknown as ReturnType<typeof spawn>;
  };
  let api: Awaited<ReturnType<typeof startWebSocketServer>>;
  try { api = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'missing.sock'), sessionHosts: {
    openTerminal, sessionsDirectory: directory, listProcesses: async () => [],
  } }); }
  catch (error) { if (skipSandbox(t, error)) return; throw error; }
  t.after(() => api.close());
  const snapshot = api.feed.snapshot();
  let sequence = 0;
  async function connect() {
    const socket = new WebSocket(`${api.wsUrl}?token=${api.token}`, { origin: api.url });
    t.after(() => socket.terminate());
    const frames: any[] = [];
    socket.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation }));
    async function command(command: string, payload: unknown, cmd_id = `hosted-${++sequence}`) {
      const before = frames.length;
      socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload }));
      await waitUntil(() => frames.slice(before).some(frame => frame.type === 'ack' && frame.cmd_id === cmd_id));
      return frames.slice(before).find(frame => frame.type === 'ack' && frame.cmd_id === cmd_id);
    }
    return { socket, frames, command };
  }
  const first = await connect();
  const payload = { projectId: 'terminal-project', provider: 'claude', resume: sessionId };
  const launched = await first.command('session.launch', payload, 'same-launch');
  assert.equal(launched.ok, true);
  await first.command('session.hosts', {});
  await first.command('session.send', { conversationId, text: 'one message' }, 'same-send');
  output('before disconnect');
  first.socket.close(); await once(first.socket, 'close');
  assert.equal(killed, false);
  output(' while disconnected');
  const next = await connect();
  assert.deepEqual(await next.command('session.launch', payload, 'same-launch'), launched);
  assert.equal(starts, 1);
  await next.command('session.send', { conversationId, text: 'one message' }, 'same-send');
  assert.deepEqual(writes, ['\x15', '\x1b[200~one message\x1b[201~', '\r']);
  const attached = await next.command('terminal.attach', { terminalId: launched.result.terminalId });
  assert.equal(attached.result.scrollback, 'before disconnect while disconnected');
  output(' live');
  await waitUntil(() => next.frames.some(frame => frame.event === 'output' && frame.data === ' live'));
  exit({ exitCode: 0 });
  await waitUntil(() => next.frames.some(frame => frame.event === 'exit'));
  assert.deepEqual((await next.command('session.hosts', {})).result, { hosts: [] });
});
