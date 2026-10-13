import { promptFrame } from './terminal-screen-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { createTargetService, buildLaunchCommand, quoteShell, validateBase, validateName, validateTarget, cacheRoot } from '../src/remote/index.ts';
import { startRemoteMirror, discoverRemoteSession } from '../src/remote/mirror.ts';
import { openObservationService } from '../src/service/index.ts';
const SESSION = '12345678-1234-1234-1234-123456789abc';
const connection = { id: 'server', name: 'Server', destination: 'dev@host', projects: [{ projectId: 'demo', path: '/remote/demo' }] };
test('shell arguments are quoted and injection in names, refs, targets and destination is rejected', async () => {
  assert.equal(quoteShell("a'b;$(touch x)"), "'a'\\''b;$(touch x)'");
  assert.match(buildLaunchCommand("/path/'$(touch x)", 'claude', SESSION, 'opus'), /cd '\/path\/'\\''\$\(touch x\)'/);
  assert.match(buildLaunchCommand('~/demo', 'codex', SESSION), /exec codex 'resume'/);
  for (const value of ['../bad', 'a/b', '-flag', '.', '..', 'x\n', 'x;touch bad', 'a$(id)']) assert.throws(() => validateName(value));
  for (const value of ['-main', '../main', 'main;id', 'main\n', 'main@{0}', 'x.lock', 'foo//bar']) assert.throws(() => validateBase(value));
  assert.equal(validateBase('refs/remotes/origin/main'), 'refs/remotes/origin/main');
  assert.throws(() => validateTarget({ kind: 'ssh', id: '../key' }));
  assert.throws(() => buildLaunchCommand('/repo', 'claude', SESSION, 'opus;id'));
  assert.equal(cacheRoot({ XDG_CACHE_HOME: '/cache' }, '/home'), '/cache/agent-graph');
});
test('worktrees, branch lists and connection tests use injectable git and SSH and persist settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-target-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls: { file: string; args: string[] }[] = [];
  let fail = false;
  const service = createTargetService(async () => '/repo/demo', { cache: directory, settingsPath: join(directory, 'ssh.toml'), execute: async (file, args) => {
    calls.push({ file, args }); if (fail) throw new Error('failure');
    if (args.at(-1)?.includes('printf')) return '/home/dev/.cache';
    if (args.includes('branch') || args.at(-1)?.includes('branch -a')) return '* main\n  remotes/origin/main\n  remotes/origin/HEAD -> origin/main\n';
    return '';
  } });
  await service.handle('ssh.write', { connections: [connection] });
  assert.deepEqual(await service.handle('ssh.read', {}), { connections: [connection] });
  assert.deepEqual(await service.handle('git.branches', { projectId: 'demo', target: { kind: 'local' } }), { branches: ['main', 'origin/main'] });
  assert.deepEqual(await service.handle('worktree.create', { projectId: 'demo', target: { kind: 'local' }, base: 'origin/main', name: 'feature' }), { path: join(directory, 'worktrees/demo/feature') });
  assert.deepEqual(calls.at(-1), { file: 'git', args: ['-C', '/repo/demo', 'worktree', 'add', '-b', 'feature', join(directory, 'worktrees/demo/feature'), 'origin/main'] });
  assert.deepEqual(await service.handle('worktree.create', { projectId: 'demo', target: { kind: 'ssh', id: 'server' }, base: 'origin/main', name: 'feature' }), { path: '/home/dev/.cache/agent-graph/worktrees/demo/feature' });
  assert.match(calls.at(-1)!.args.at(-1)!, /git -C '\/remote\/demo' worktree add -b 'feature'/);
  assert.deepEqual(await service.handle('git.branches', { projectId: 'demo', target: { kind: 'ssh', id: 'server' } }), { branches: ['main', 'origin/main'] });
  assert.deepEqual(await service.handle('ssh.test', { destination: 'dev@host' }), { connected: true });
  assert.deepEqual(calls.at(-1), { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'dev@host', 'true'] });
  fail = true; assert.deepEqual(await service.handle('ssh.test', { destination: 'dev@host' }), { connected: false });
  const count = calls.length;
  await assert.rejects(service.handle('ssh.test', { destination: '-oProxyCommand=id' }));
  await assert.rejects(service.handle('worktree.create', { projectId: 'demo', name: 'bad;id', base: 'main' }));
  assert.equal(calls.length, count);
});
test('remote discovery selects descendants and uses the newest matching cwd only when process traversal is unavailable', async () => {
  const service = createTargetService(async () => '/repo', { execute: async (_file, args) => {
    const cmd = args.at(-1)!;
    if (cmd.startsWith('cd')) return cmd.includes('/other') ? '/other' : '/remote/demo';
    if (cmd.startsWith('ps')) return '100 1\n200 100\n';
    return `\x1e${Date.now() / 1000}\n${JSON.stringify({ sessionId: SESSION, pid: 200, cwd: '/remote/demo' })}`;
  } });
  assert.equal((await discoverRemoteSession(service, connection, '/remote/demo', new Date().toISOString(), 100))?.sessionId, SESSION);
  assert.equal(await discoverRemoteSession(service, connection, '/other', new Date().toISOString(), 999), undefined);
  assert.equal((await discoverRemoteSession(service, connection, '/remote/demo', new Date().toISOString()))?.sessionId, SESSION);
});
test('remote mirror appends complete UTF-8 lines, observes them with the registered project and stops on disconnect', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-mirror-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const calls: string[][] = [];
  const service = createTargetService(async () => '/repo', { cache: join(directory, '.cache/agent-graph'), spawnStream: ((_file: string, args: readonly string[]) => { calls.push(args as string[]); return child; }) as unknown as typeof spawn });
  let disconnected = false;
  const mirror = startRemoteMirror(service, connection, `/remote/.claude/projects/demo/${SESSION}.jsonl`, SESSION, 'demo', '/remote/demo', () => { disconnected = true; });
  assert.match(calls[0].at(-1)!, /tail -n \+1 -F/);
  const line = JSON.stringify({ type: 'user', uuid: 'message', sessionId: SESSION, timestamp: new Date().toISOString(), cwd: '/remote/demo', message: { role: 'user', content: 'こんにちは' } }) + '\n';
  const bytes = Buffer.from(line); child.stdout.write(bytes.subarray(0, bytes.length - 5));
  await assert.rejects(readFile(mirror.path));
  child.stdout.write(bytes.subarray(bytes.length - 5));
  assert.equal(await readFile(mirror.path, 'utf8'), line);
  const observation = openObservationService({ home: directory, env: { HOME: directory }, dbPath: join(directory, 'ledger.db') });
  t.after(() => observation.close()); observation.ingestOnce();
  const facts = observation.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.ok(facts.some(fact => fact.kind === 'message.created'));
  assert.ok(facts.some(fact => fact.kind === 'conversation.updated' && fact.payload?.repository_id === 'demo'));
  child.emit('exit', 255); assert.equal(disconnected, true);
  child.stdout.write(line); assert.equal(await readFile(mirror.path, 'utf8'), line);
  assert.equal(JSON.parse(await readFile(mirror.path + '.remote.json', 'utf8')).disconnected, true);
  observation.ingestOnce();
  assert.ok(observation.ledger.readSince(0, Number.MAX_SAFE_INTEGER).some(fact => fact.kind === 'run.state_changed' && fact.payload?.reason === 'disconnected'));
});

test('SSH hosted terminals safely launch, attach, send, interrupt and report disconnect', async t => {
  const { createSessionHosts } = await import('../src/terminal/hosts.ts');
  const directory = await mkdtemp(join(tmpdir(), 'ag-ssh-host-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let output = (_data: string) => {}, exit = (_event: { exitCode: number }) => {};
  const writes: string[] = [], launches: { file: string; args: string[] | string }[] = [];
  const stream = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
  const targets = createTargetService(async () => '/local/demo', { cache: directory, settingsPath: join(directory, 'ssh.toml'), execute: async (_file, args) => {
    const command = args.at(-1)!;
    if (command.startsWith('cd')) return '/remote/demo';
    if (command.startsWith('ps')) return '200 1\n300 200\n';
    if (command.startsWith('find')) return `/home/dev/.claude/projects/demo/${SESSION}.jsonl`;
    return `\x1e${Date.now() / 1000}\n${JSON.stringify({ sessionId: SESSION, cwd: '/remote/demo', pid: 300 })}`;
  }, spawnStream: (() => stream) as unknown as typeof spawn });
  await targets.handle('ssh.write', { connections: [connection] });
  const hosts = createSessionHosts(async () => '/local/demo', { targets, submitDelayMs: 0, quietMs: 0, warmupMs: 0, openTerminal: ((file: string, args: string[] | string) => {
    launches.push({ file, args });
    return { pid: 100, write: (text: string) => writes.push(text), resize() {}, kill() {},
      onData: (fn: typeof output) => { output = fn; return { dispose() {} }; }, onExit: (fn: typeof exit) => { exit = fn; return { dispose() {} }; } };
  }) as unknown as import('../src/terminal/hosts.ts').HostOptions['openTerminal'] });
  t.after(() => hosts.close()); const notify = () => {};
  const launch = await hosts.handle('session.launch', { projectId: 'demo', provider: 'claude', target: { kind: 'ssh', id: 'server' }, model: 'opus' }, notify) as { terminalId: string };
  assert.equal(launches[0].file, 'ssh'); assert.ok(launches[0].args.includes('-tt'));
  assert.match((launches[0].args as string[]).at(-1)!, /cd '\/remote\/demo'.*exec claude '--model' 'opus'/);
  output('\x1b]777;agent-graph-'); output('pid=200\x07' + 'screen'.repeat(100));
  const list = await hosts.handle('session.hosts', {}, notify) as { hosts: { conversationId: string; terminalId: string; disconnected: boolean }[] };
  assert.equal(list.hosts[0].conversationId, JSON.stringify(['claude', SESSION]));
  await hosts.handle('terminal.attach', { terminalId: launch.terminalId }, notify);
  output(promptFrame());
  await hosts.handle('session.send', { conversationId: list.hosts[0].conversationId, text: 'message; $(id)' }, notify);
  await hosts.handle('session.interrupt', { conversationId: list.hosts[0].conversationId }, notify);
  assert.deepEqual(writes, ['\x15', '\x1b[200~message; $(id)\x1b[201~', '\r', '\x1b']);
  exit({ exitCode: 255 });
  assert.equal((await hosts.handle('session.hosts', {}, notify) as typeof list).hosts[0].disconnected, true);
  await assert.rejects(hosts.handle('session.send', { conversationId: list.hosts[0].conversationId, text: 'no' }, notify), /no_host/);
});

test('Codex discovery follows children and launch runs inside the selected local worktree', async t => {
  const { discoverCodex } = await import('../src/remote/codex.ts');
  const { createSessionHosts } = await import('../src/terminal/hosts.ts');
  const directory = await mkdtemp(join(tmpdir(), 'ag-codex-target-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = join(directory, `rollout-2026-10-11-${SESSION}.jsonl`);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: '/cache/tree' } }) + '\n');
  const calls: string[][] = [];
  const selectRoot = async (request: { projectId: string; worktree?: string }) => request.worktree ?? '/repo/demo';
  const targets = createTargetService(selectRoot, { settingsPath: join(directory, 'ssh.toml'), execute: async (file, args) => {
    calls.push([file, ...args]); return file === 'ps' ? '100 1\n200 100\n' : `p200\nn${rollout}\n`;
  } });
  assert.equal((await discoverCodex(targets, 100))?.sessionId, SESSION);
  assert.deepEqual(calls.at(-1), ['lsof', '-nP', '-p', '100,200', '-F', 'n']);
  const launches: { file: string; args: string[] | string; cwd: string | undefined }[] = [];
  const hosts = createSessionHosts(selectRoot, { targets, openTerminal: ((file: string, args: string[] | string, options: { cwd?: string }) => {
    launches.push({ file, args, cwd: options.cwd });
    return { pid: 100, write() {}, resize() {}, kill() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  }) as unknown as import('../src/terminal/hosts.ts').HostOptions['openTerminal'] });
  t.after(() => hosts.close());
  await hosts.handle('session.launch', { projectId: 'demo', provider: 'codex', target: { kind: 'local' }, worktree: '/cache/tree', model: 'gpt-5' }, () => {});
  assert.deepEqual(launches[0], { file: 'codex', args: ['--model', 'gpt-5'], cwd: '/cache/tree' });
  assert.equal((await hosts.handle('session.hosts', {}, () => {}) as { hosts: { conversationId: string }[] }).hosts[0].conversationId, JSON.stringify(['codex', SESSION]));
});
