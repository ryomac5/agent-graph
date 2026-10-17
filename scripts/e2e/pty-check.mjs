import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { assertIsolation, verifyPtyHelper, readActors, readJson, waitFor, launch, stopProcess, DIRECTORY, START_TIMEOUT_MS } from './isolation.mjs';
import { scriptActor } from './journeys.mjs';
const root = await assertIsolation(); await verifyPtyHelper();
const state = join(root, 'state/agent-graph');
if (process.cwd() !== state) throw new Error('PTY check must start in the isolated state directory');
const { createSessionHosts } = await import('../../packages/api/src/terminal/hosts.ts');
const { RunnerClient } = await import('../../packages/api/src/runner-client.ts');
// runner の Unix socket を通し、製品の PTY・貼り付け・画面解釈は実物を使う。
// ps の sandbox 拒否だけを避け、既知の直系 PID の session file で発見する。
const runner = launch(process.execPath, [join(DIRECTORY, 'services.mjs'), 'runner'], { cwd: state, env: process.env });
let hosts;
const notices = [];
const notify = notice => notices.push(notice);
try {
  const checkRunner = () => {
    if (!runner.child.pid || runner.child.exitCode !== null || runner.child.signalCode !== null)
      throw new Error(`Runner startup failed: ${runner.output()}`);
  };
  await waitFor(async () => {
    checkRunner();
    const ready = await readJson(join(root, 'runner-ready.json'));
    return ready?.pid === runner.child.pid;
  }, 'PTY runner startup', START_TIMEOUT_MS);
  let client;
  hosts = createSessionHosts(async () => process.env.E2E_PROJECT, {
    // macOS の socket パス長制限を避け、services.mjs と同じ cwd から接続する。
    createRunnerClient: onEvent => (client = new RunnerClient('runner.sock', onEvent)),
    listProcesses: async () => [], warmupMs: 0, quietMs: 0, submitDelayMs: 20,
  });
  await waitFor(() => { checkRunner(); return client.available; }, 'PTY runner connection', START_TIMEOUT_MS);
  const launch = await hosts.handle('session.launch', { projectId: 'fixture', provider: 'claude' }, notify);
  const actor = await waitFor(async () => (await readActors(process.env.E2E_CONTROL)).find(row => row.id), 'PTY actor');
  const id = JSON.stringify(['claude', actor.id]);
  await waitFor(async () => (await hosts.handle('session.hosts', {}, notify)).hosts.some(host => host.conversationId === id), 'PTY discovery');
  await hosts.handle('terminal.attach', { terminalId: launch.terminalId }, notify);
  await hosts.handle('session.send', { conversationId: id, text: 'PTY first' }, notify);
  await waitFor(async () => (await readFile(actor.path, 'utf8')).includes('E2E reply: PTY first'), 'PTY reply');
  await scriptActor(process.env.E2E_CONTROL, actor.pid, 'hold-next');
  await hosts.handle('session.send', { conversationId: id, text: 'PTY working' }, notify);
  await hosts.handle('session.send', { conversationId: id, text: 'PTY queued' }, notify);
  await waitFor(async () => (await readFile(actor.path, 'utf8')).includes('"operation":"enqueue"'), 'PTY queue');
  await scriptActor(process.env.E2E_CONTROL, actor.pid, 'release');
  const result = await hosts.handle('session.send', { conversationId: id, text: '/model haiku' }, notify);
  assert.equal(result.command.status, 'interactive');
  assert.ok(result.command.output.includes('Switch model?'));
  await assert.rejects(hosts.handle('session.send', { conversationId: id, text: 'must be blocked' }, notify), /not ready/);
  await hosts.handle('terminal.input', { terminalId: launch.terminalId, data: '\r' }, notify);
  await waitFor(async () => (await readFile(actor.path, 'utf8')).includes('Set model to'), 'PTY confirmation');
  assert.ok(!notices.some(notice => notice.data?.includes('must be blocked')));
  console.log('Real PTY, queue, model panel, double-send rejection: PASS');
} finally {
  try { hosts?.close(); }
  finally { await stopProcess(runner); }
}
