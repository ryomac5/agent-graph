import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { spawn } from 'node-pty';
import { createSessionHosts, MAX_SCROLLBACK_BYTES, type HostOptions } from '../src/terminal/hosts.ts';
import { escapeAttachmentPath } from '../src/terminal/attachments.ts';
import type { TerminalNotification } from '../src/terminal/index.ts';

const HOST_DISCOVERY_TIMEOUT_MS = 5000;
const HOST_DISCOVERY_POLL_MS = 10;
const SESSION = '12345678-1234-1234-1234-123456789abc';
const conversationId = JSON.stringify(['claude', SESSION]);
async function createFixture(t: TestContext, waits?: number[], options: HostOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ag session-hosts-'));
  const children: { pid: number; killed: boolean; writes: string[]; output: (data: string) => void; exit: (event: { exitCode: number }) => void }[] = [];
  const launches: { file: string; args: string[] | string; options: Parameters<typeof spawn>[2] }[] = [];
  const openTerminal: typeof spawn = (file, args, options) => {
    launches.push({ file, args, options });
    const child = { pid: 1000 + children.length, killed: false, writes: [] as string[], output: (_data: string) => {}, exit: (_event: { exitCode: number }) => {} };
    children.push(child);
    return {
      pid: child.pid,
      write(data: string) { child.writes.push(data); }, resize() {},
      kill() { child.killed = true; child.exit({ exitCode: 0 }); },
      onData(callback: typeof child.output) { child.output = callback; return { dispose() {} }; },
      onExit(callback: typeof child.exit) { child.exit = callback; return { dispose() {} }; },
    } as unknown as ReturnType<typeof spawn>;
  };
  const waitWrites: string[][] = [];
  const messages: TerminalNotification[] = [];
  const notify = (message: TerminalNotification) => messages.push(message);
  const hosts = createSessionHosts(async () => '/repo', { openTerminal, quietMs: 0, warmupMs: 0, sessionsDirectory: directory, attachments: { directory: join(directory, 'attachments') }, submitDelayMs: waits ? 500 : 0, wait: async ms => { waits?.push(ms); waitWrites.push([...children[0].writes]); },
    listProcesses: async () => [{ pid: 2000, ppid: 1000 }, { pid: 3000, ppid: 2000 }, { pid: 9999, ppid: 1 }], ...options });
  t.after(async () => { hosts.close(); await rm(directory, { recursive: true, force: true }); });
  const handle = (command: string, payload: unknown = {}) => hosts.handle(command, payload, notify);
  const launch = (resume?: string) => handle('session.launch', { projectId: 'p', provider: 'claude', ...(resume ? { resume } : {}) }) as Promise<{ terminalId: string; pid: number }>;
  return { directory, children, launches, messages, hosts, notify, handle, launch, waitWrites };
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: a ready terminal acknowledges sends within one second during continuous output`, async t => {
    let rollout = '';
    const f = await createFixture(t, undefined, {
      quietMs: undefined, warmupMs: undefined, submitDelayMs: undefined, wait: undefined,
      targetOptions: { execute: async file => file === 'lsof' ? `n${rollout}` : '' },
    });
    rollout = join(f.directory, `rollout-test-${SESSION}.jsonl`);
    await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: '/repo' } }));
    await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
    await f.handle('session.launch', { projectId: 'p', provider, resume: SESSION });
    const id = JSON.stringify([provider, SESSION]);
    const result = await f.handle('session.hosts') as { hosts: { conversationId: string }[] };
    assert.equal(result.hosts[0].conversationId, id);
    f.children[0].output('\x1b[?2004h');
    // 最初のチャット送信より前に準備を終え、端末側で作業が始まった場合も含める。
    await delay(3100);
    let renders = 0;
    const render = () => { renders++; f.children[0].output('\r\x1b[2K⠋ Working'); };
    render();
    const spinner = setInterval(render, 25);
    t.after(() => clearInterval(spinner));
    const image = await f.handle('attachment.put', { name: 'test.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }) as { attachmentId: string; path: string };
    for (const withImage of [false, true]) {
      const before = renders, started = performance.now();
      const text = '日本語の入力\nsecond line';
      const response = await f.handle('session.send', { conversationId: id, text,
        ...(withImage ? { attachments: [image.attachmentId] } : {}) });
      const elapsed = performance.now() - started;
      t.diagnostic(`${provider} ${withImage ? 'image' : 'text'} send before ack: ${elapsed.toFixed(1)} ms`);
      assert.ok(elapsed < 1100, `send took ${elapsed.toFixed(1)} ms`);
      assert.deepEqual(response, {});
      assert.ok(renders > before, 'output continues between paste and Enter');
      assert.deepEqual(f.children[0].writes.splice(0), ['\x15',
        ...(withImage ? [`\x1b[200~${escapeAttachmentPath(image.path)}\x1b[201~`] : []),
        `\x1b[200~${withImage ? ' ' : ''}${text}\x1b[201~`, '\r']);
    }
  });
}

test('startup waits for both warmup and quiet before pasting, then preserves paste and Enter spacing', async t => {
  const started = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: started });
  const waits: number[] = [];
  const f = await createFixture(t, undefined, {
    quietMs: undefined, warmupMs: undefined, submitDelayMs: undefined,
    wait: async ms => {
      waits.push(ms);
      if (Date.now() - started < 3200) assert.deepEqual(f.children[0].writes, []);
      else assert.equal(f.children[0].writes.at(-1), '\x1b[200~first\x1b[201~');
      t.mock.timers.tick(ms);
      if (Date.now() - started === 2400) f.children[0].output('startup redraw');
    },
  });
  await f.launch(SESSION);
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  await f.handle('session.hosts');
  await f.handle('session.send', { conversationId, text: 'first' });
  assert.deepEqual(waits, [...Array<number>(32).fill(100), 500]);
  assert.deepEqual(f.children[0].writes, ['\x15', '\x1b[200~first\x1b[201~', '\r']);
});

test('continuous startup output uses one deadline from launch, including the first send', async t => {
  const started = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: started });
  const waits: number[] = [];
  const f = await createFixture(t, undefined, {
    quietMs: undefined, warmupMs: undefined,
    wait: async ms => { waits.push(ms); t.mock.timers.tick(ms); f.children[0].output('working'); },
  });
  await f.launch(SESSION);
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  await f.handle('session.hosts');
  t.mock.timers.tick(14_500);
  f.children[0].output('working');
  await f.handle('session.send', { conversationId, text: 'first' });
  assert.deepEqual(waits, Array<number>(5).fill(100));
  waits.length = 0;
  await f.handle('session.send', { conversationId, text: 'second' });
  assert.deepEqual(waits, []);
});

test('launch accepts supported providers, UUID resume and a plain model name', async t => {
  const f = await createFixture(t);
  for (const resume of ['', '../session', '--danger', '1234', SESSION + '\n']) {
    await assert.rejects(f.handle('session.launch', { projectId: 'p', provider: 'claude', resume }), /Invalid session launch/);
  }
  for (const model of ['', '-flag', 'opus;touch x', 'model name', 'model/other', 'opus\n']) {
    await assert.rejects(f.handle('session.launch', { projectId: 'p', provider: 'claude', model }), /Invalid session launch/);
  }
  for (const extra of [{ provider: 'other' }, { args: ['--help'] }, { command: 'sh' }, { cwd: '/elsewhere' }]) {
    await assert.rejects(f.handle('session.launch', { projectId: 'p', provider: 'claude', ...extra }), /Invalid session launch/);
  }
  const saved = { AGENT_GRAPH_TEST_SECRET: process.env.AGENT_GRAPH_TEST_SECRET, CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_TEST: process.env.CLAUDE_CODE_TEST };
  Object.assign(process.env, { AGENT_GRAPH_TEST_SECRET: 'secret', CLAUDECODE: '1', CLAUDE_CODE_TEST: 'nested' });
  try {
    await f.handle('session.launch', { projectId: 'p', provider: 'claude', resume: SESSION, model: 'claude-opus_5.5' });
    const launched = f.launches[0];
    assert.equal(launched.file, 'claude');
    assert.deepEqual(launched.args, ['--resume', SESSION, '--model', 'claude-opus_5.5']);
    assert.equal(launched.options.cwd, '/repo');
    assert.equal(launched.options.env!.TERM, 'xterm-256color');
    assert.equal(launched.options.env!.PATH, process.env.PATH);
    for (const name of Object.keys(saved)) assert.equal(launched.options.env![name], undefined);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('session files bind descendants, queue input in order and send paste followed by CR', async t => {
  const f = await createFixture(t);
  const launched = await f.launch(SESSION);
  await f.handle('session.hosts');
  await f.handle('session.send', { conversationId, text: 'first\nline' });
  await f.handle('session.send', { conversationId, text: 'second' });
  assert.deepEqual(f.children[0].writes, []);
  await writeFile(join(f.directory, '9999.json'), JSON.stringify({ pid: 9999, sessionId: SESSION }));
  await writeFile(join(f.directory, '1000.json'), '{');
  assert.deepEqual(await f.handle('session.hosts'), { hosts: [] });
  await writeFile(join(f.directory, '3000.json'), JSON.stringify({ pid: 3000, sessionId: SESSION }));
  const result = await f.handle('session.hosts') as { hosts: { conversationId: string; terminalId: string; pid: number; startedAt: string }[] };
  assert.deepEqual(result.hosts.map(({ startedAt, ...row }) => row), [{ conversationId, terminalId: launched.terminalId, pid: 1000 }]);
  assert.ok(Number.isFinite(Date.parse(result.hosts[0].startedAt)));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.children[0].writes, ['\x15', '\x1b[200~first\nline\x1b[201~', '\r', '\x15', '\x1b[200~second\x1b[201~', '\r']);
  await f.handle('session.send', { conversationId, text: 'third' });
  await f.handle('session.interrupt', { conversationId });
  assert.deepEqual(f.children[0].writes.slice(-4), ['\x15', '\x1b[200~third\x1b[201~', '\r', '\x1b']);
  await assert.rejects(f.handle('session.send', { conversationId: 'unknown', text: 'no' }), /no_host/);
  await assert.rejects(f.launch(SESSION), /Session already hosted/);
});

test('new sessions bind direct PIDs and reject mismatched PID files', async t => {
  const f = await createFixture(t);
  const launched = await f.launch();
  await f.handle('session.hosts');
  assert.deepEqual(f.launches[0].args, []);
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 99, sessionId: SESSION }));
  assert.deepEqual(await f.handle('session.hosts'), { hosts: [] });
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const result = await f.handle('session.hosts') as { hosts: { conversationId: string; terminalId: string }[] };
  assert.equal(result.hosts[0].conversationId, conversationId);
  assert.equal(result.hosts[0].terminalId, launched.terminalId);
});

test('disconnect preserves hosts, attach restores bounded UTF-8 scrollback and scopes notifications', async t => {
  const f = await createFixture(t);
  const launched = await f.launch(SESSION);
  f.children[0].output('old'.repeat(MAX_SCROLLBACK_BYTES));
  f.children[0].output('日本語');
  assert.equal(f.messages.length, 0);
  const restored = await f.handle('terminal.attach', { terminalId: launched.terminalId }) as { scrollback: string };
  assert.ok(Buffer.byteLength(restored.scrollback) <= MAX_SCROLLBACK_BYTES);
  assert.ok(restored.scrollback.endsWith('日本語'));
  assert.ok(!restored.scrollback.includes('�'));
  f.children[0].output('live');
  assert.equal(f.messages.length, 1);
  f.hosts.detach(f.notify);
  assert.equal(f.children[0].killed, false);
  f.children[0].output('offline');
  assert.equal(f.messages.length, 1);
  const other: TerminalNotification[] = [];
  const notify = (message: TerminalNotification) => other.push(message);
  await assert.rejects(f.hosts.handle('terminal.input', { terminalId: launched.terminalId, data: 'no' }, notify), /Unknown terminal/);
  const attached = await f.hosts.handle('terminal.attach', { terminalId: launched.terminalId }, notify) as { scrollback: string };
  assert.ok(attached.scrollback.endsWith('liveoffline'));
  await f.hosts.handle('terminal.input', { terminalId: launched.terminalId, data: 'yes' }, notify);
  f.children[0].output('again');
  assert.equal(other.length, 1);
  assert.equal(f.messages.length, 1);
  f.children[0].exit({ exitCode: 0 });
  assert.equal(f.hosts.hasTerminal(launched.terminalId), false);
  await assert.rejects(f.handle('session.interrupt', { conversationId }), /no_host/);
});

test('eight hosts including pending launches is the shared limit and exiting releases a slot', async t => {
  const f = await createFixture(t);
  const launches = Array.from({ length: 8 }, () => f.launch());
  await assert.rejects(f.launch(), /Terminal limit reached/);
  await Promise.all(launches);
  f.children[0].exit({ exitCode: 0 });
  await f.launch();
  assert.equal(f.launches.length, 9);
});


test('image sends paste each escaped path, wait 300ms, paste body, wait 500ms and submit in queue order', async t => {
  const waits: number[] = [];
  const f = await createFixture(t, waits);
  await f.launch(SESSION);
  await writeFile(join(f.directory, '1000.json'), JSON.stringify({ pid: 1000, sessionId: SESSION }));
  const deadline = Date.now() + HOST_DISCOVERY_TIMEOUT_MS;
  // 起動時の走査がファイル作成前に始まっていても、実際の所属確認を待つ。
  while (!((await f.handle('session.hosts')) as { hosts: { conversationId: string }[] }).hosts.some(host => host.conversationId === conversationId)) {
    assert.ok(Date.now() < deadline, 'Session discovery timed out');
    await new Promise(resolve => setTimeout(resolve, HOST_DISCOVERY_POLL_MS));
  }
  const image = await f.handle('attachment.put', { name: 'test.png', mime: 'image/png', dataBase64: 'iVBORw0KGgo=' }) as { attachmentId: string; path: string };
  const first = f.handle('session.send', { conversationId, text: 'body', attachments: [image.attachmentId, image.attachmentId] });
  const second = f.handle('session.send', { conversationId, text: '' , attachments: [image.attachmentId] });
  await Promise.all([first, second]);
  assert.deepEqual(waits, [300, 500, 300, 500]);
  const paste = '\x1b[200~' + escapeAttachmentPath(image.path) + '\x1b[201~';
  assert.deepEqual(f.children[0].writes, ['\x15', paste, paste, '\x1b[200~ body\x1b[201~', '\r', '\x15', paste, '\x1b[200~ \x1b[201~', '\r']);
  assert.deepEqual(f.waitWrites.map(writes => writes.at(-1)), [paste, '\x1b[200~ body\x1b[201~', paste, '\x1b[200~ \x1b[201~']);
  await assert.rejects(f.handle('session.send', { conversationId, text: 'bad', attachments: ['../bad'] }), /Invalid attachments/);
  await f.handle('session.send', { conversationId, text: 'recovery' });
  assert.equal(f.children[0].writes.at(-1), '\r');
});
