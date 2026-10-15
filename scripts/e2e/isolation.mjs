import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, realpath, readFile, readdir, rm, rmdir, stat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY = resolve(DIRECTORY, '../..');
export const PLAYWRIGHT = '/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs';
export const TIMEOUT_MS = 20_000;
export const START_TIMEOUT_MS = 45_000;
export const WATCH_TIMEOUT_MS = 75_000;

export function inside(root, path) {
  return resolve(path).startsWith(resolve(root) + sep);
}
export async function waitFor(check, label, timeout = TIMEOUT_MS) {
  const deadline = performance.now() + timeout;
  let last;
  do {
    last = await check();
    if (last) return last;
    await delay(100);
  } while (performance.now() < deadline);
  throw new Error(`${label} (${timeout} ms)`);
}
export async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n'); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function createIsolation(parentRoot) {
  if (parentRoot) {
    assert.ok(inside(join(DIRECTORY, '.runs'), parentRoot));
    assert.equal((await readJson(join(parentRoot, 'owner.json')))?.root, parentRoot);
    assert.equal(await realpath(parentRoot), parentRoot);
  }
  const parent = parentRoot ? join(parentRoot, 'checks') : join(DIRECTORY, '.runs');
  await mkdir(parent, { recursive: true });
  assert.equal(await realpath(parent), parent, '隔離先の symlink は使えません');
  const root = await mkdtemp(join(parent, 'run-'));
  const paths = {
    root, home: join(root, 'home'), state: join(root, 'state', 'agent-graph'),
    project: join(root, 'journey-project'), bin: join(root, 'bin'), tmp: join(root, 'tmp'),
    control: join(root, 'control'), dist: join(root, 'dist'),
    config: join(root, 'config'), cache: join(root, 'cache'),
  };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true });
  for (const name of ['.claude/projects', '.claude/sessions', '.codex/sessions']) await mkdir(join(paths.home, name), { recursive: true });
  await writeFile(join(root, 'owner.json'), JSON.stringify({ pid: process.pid, root }));
  await symlink(process.execPath, join(paths.bin, 'node'));
  for (const provider of ['claude', 'codex']) {
    // PATH と SDK の明示パスの両方を、必ずこの実行ファイルに向ける。
    await writeFile(join(paths.bin, provider), `#!${process.execPath}\nimport(${JSON.stringify(new URL('./fake-cli.mjs', import.meta.url).href)}).then(m => m.main(${JSON.stringify(provider)}));\n`, { mode: 0o700 });
  }
  const env = {
    PATH: `${paths.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home, USER: 'e2e', LOGNAME: 'e2e', SHELL: '/bin/sh',
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC', TERM: 'xterm-256color',
    TMPDIR: paths.tmp, TMP: paths.tmp, TEMP: paths.tmp,
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache, XDG_DATA_HOME: join(root, 'data'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    CLAUDE_CONFIG_DIR: join(paths.home, '.claude'), CODEX_HOME: join(paths.home, '.codex'),
    AGENT_GRAPH_CLAUDE_BIN: join(paths.bin, 'claude'), AGENT_GRAPH_CODEX_BIN: join(paths.bin, 'codex'),
    AGENT_GRAPH_PORT: '0', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    E2E_ROOT: root, E2E_PROJECT: paths.project, E2E_CONTROL: paths.control,
    E2E_HOOK_DESTINATION: join(root, 'hook-destination.json'),
  };
  for (const key of ['XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) await mkdir(env[key], { recursive: true });
  // ロゴだけは合成のキャッシュを用意し、静的配信から外部 CDN を呼ばせない。
  const brand = join(paths.cache, 'agent-graph/brand');
  await mkdir(brand, { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2H22V22H2Z"/></svg>';
  for (const name of ['claude', 'openai']) await writeFile(join(brand, `${name}.svg`), svg);
  await writeJson(join(env.CLAUDE_CONFIG_DIR, 'settings.json'), { model: 'sonnet' });
  return { ...paths, env };
}

export async function assertIsolation(env = process.env) {
  const root = env.E2E_ROOT;
  assert.ok(root && inside(join(DIRECTORY, '.runs'), root), 'E2E_ROOT must be an owned workspace directory');
  assert.equal(await realpath(root), root);
  const owner = await readJson(join(root, 'owner.json'));
  assert.equal(owner?.root, root);
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'E2E_PROJECT', 'E2E_CONTROL', 'E2E_HOOK_DESTINATION']) {
    assert.ok(env[key] && inside(root, env[key]), `${key} escapes isolation`);
  }
  return root;
}

export function launch(command, args, { cwd, env, log }) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; log?.write(chunk); });
  child.stderr.on('data', chunk => { output += chunk; log?.write(chunk); });
  const closed = new Promise(resolveExit => {
    child.once('error', error => resolveExit({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  return { child, closed, output: () => output };
}
export async function runCommand(command, args, options) {
  const run = launch(command, args, options);
  const terminate = () => { if (run.child.pid) { try { process.kill(-run.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
  const timer = setTimeout(terminate, 120_000);
  options.signal?.addEventListener('abort', terminate, { once: true });
  if (options.signal?.aborted) terminate();
  try {
    const result = await run.closed;
    assert.equal(result.code, 0, `${command} failed: ${result.error ?? run.output()}`);
    return run.output();
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', terminate); }
}
export async function stopProcess(run) {
  if (!run.child.pid) return;
  const kill = signal => { try { process.kill(-run.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  kill('SIGTERM');
  await Promise.race([run.closed, delay(3000)]);
  kill('SIGKILL');
  await run.closed;
}
export async function removeIsolation(isolation) {
  await assertIsolation(isolation.env);
  assert.equal((await readJson(join(isolation.root, 'owner.json'))).pid, process.pid);
  await rm(isolation.root, { recursive: true, force: true });
  await rmdir(dirname(isolation.root)).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
}
export async function readActors(control) {
  const actors = [];
  for (const name of await readdir(control)) {
    if (!/^\d+$/.test(name)) continue;
    const state = await readJson(join(control, name, 'state.json'));
    if (state) actors.push(state);
  }
  return actors;
}

export async function verifyPtyHelper() {
  if (process.platform !== 'darwin') return;
  const require = createRequire(join(REPOSITORY, 'packages/api/package.json'));
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const name of ['build/Release/spawn-helper', 'build/Debug/spawn-helper', `prebuilds/${process.platform}-${process.arch}/spawn-helper`]) {
    const metadata = await stat(join(root, name)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!metadata) continue;
    assert.ok(metadata.mode & 0o100, 'node-pty helper の実行権限がありません。E2E は共有依存の権限を変更しません');
    return;
  }
  throw new Error('Installed node-pty spawn-helper is missing');
}
