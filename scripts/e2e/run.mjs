#!/usr/bin/env node
import { STATE_JOURNEYS } from './state-journeys.mjs';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { DIRECTORY, REPOSITORY, PLAYWRIGHT, createIsolation, launch, runCommand, stopProcess, removeIsolation, readActors, readJson, waitFor, verifyPtyHelper, START_TIMEOUT_MS } from './isolation.mjs';
import { Report } from './report.mjs';

const started = new Date().toISOString();
const name = started.replace(/[:.]/g, '-') + '-' + process.pid;
const directory = join(DIRECTORY, 'results', name);
const git = args => execFileSync('git', args, { cwd: REPOSITORY, encoding: 'utf8' }).trim();
const report = new Report(directory, { started, head: git(['rev-parse', 'HEAD']), main: git(['rev-parse', 'main']), branch: git(['branch', '--show-current']),
  productDiffFromMain: git(['diff', '--name-only', 'HEAD', 'main', '--', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']),
  stateFaults: STATE_JOURNEYS.map(([id, name]) => ({ id, name })), fakeClaudeVersion: '2.1.299', realProviderCalls: 0 });
await report.initialize();
let isolation, browser;
const originalTemporaryEnvironment = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]));
const processes = [], logs = [];
const abort = new AbortController();
const signal = name => { report.errors.push(`Interrupted: ${name}`); abort.abort(new Error(name)); };
process.once('SIGINT', () => signal('SIGINT')); process.once('SIGTERM', () => signal('SIGTERM'));
const overall = setTimeout(() => signal('E2E 全体の 15 分制限'), 15 * 60_000);
const ensureActive = () => { if (abort.signal.aborted) throw abort.signal.reason; };
function openLog(name) { const log = createWriteStream(join(directory, name)); logs.push(log); return log; }
function track(command, args, options) { const run = launch(command, args, options); processes.push(run); return run; }
async function ready(run, path) {
  return waitFor(async () => {
    ensureActive();
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`Service startup failed: ${run.output()}`);
    return readJson(path);
  }, `サービスの起動: ${path}`, START_TIMEOUT_MS);
}
async function probeListen() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function buildDashboard() {
  const require = createRequire(join(REPOSITORY, 'packages/dashboard/package.json'));
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  await runCommand(process.execPath, [vite, 'build', '--configLoader', 'native', '--config', join(REPOSITORY, 'packages/dashboard/vite.config.ts'), '--outDir', isolation.dist],
    { cwd: isolation.project, env: isolation.env, log: openLog('build.log'), signal: abort.signal });
}
try {
  isolation = await createIsolation();
  report.metadata.isolation = { root: isolation.root, state: isolation.state, project: isolation.project, temporaryPort: true };
  await runCommand('/usr/bin/git', ['init', '--initial-branch=main', isolation.project], { cwd: isolation.root, env: isolation.env });
  console.log('偽 CLI と隔離・判定処理を確認しています。');
  await runCommand(process.execPath, ['--test', join(DIRECTORY, 'harness.test.mjs')],
    { cwd: isolation.root, env: { ...isolation.env, E2E_CHECK_ROOT: isolation.root }, log: openLog('harness-tests.log'), signal: abort.signal });
  report.metadata.harnessTests = 'pass'; ensureActive();
  console.log('隔離した dashboard を build しています。');
  await buildDashboard();
  report.metadata.build = 'pass'; await report.save(); ensureActive();
  await verifyPtyHelper();
  await probeListen();
  const runner = track(process.execPath, [join(DIRECTORY, 'services.mjs'), 'runner'], { cwd: isolation.state, env: isolation.env, log: openLog('runner.log') });
  await ready(runner, join(isolation.root, 'runner-ready.json'));
  const api = track(process.execPath, [join(DIRECTORY, 'services.mjs'), 'api'], { cwd: isolation.state, env: isolation.env, log: openLog('api.log') });
  const address = await ready(api, join(isolation.root, 'api-ready.json'));
  report.metadata.address = address;
  // Playwright 自身が作るプロファイル・trace の一時ファイルも同じ囲いへ置く。
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = isolation.tmp;
  const { chromium } = await import(PLAYWRIGHT);
  // 実行ファイルの場所だけ取得し、ブラウザの HOME とプロファイルは隔離する。
  browser = await chromium.launch({ headless: !process.argv.includes('--headed'), executablePath: chromium.executablePath(), env: isolation.env });
  const { runJourneys } = await import('./journeys.mjs');
  await runJourneys({ browser, isolation, url: address.url, report, signal: abort.signal });
  if (process.argv.some(value => value.startsWith('--only='))) await report.blockRemaining('--only で除外したため未実行');
} catch (error) {
  const reason = error.stack ?? String(error);
  report.errors.push(reason); console.error(reason);
  await report.blockRemaining(error.message ?? String(error));
} finally {
  clearTimeout(overall);
  const cleanupErrors = [];
  if (browser) { try { await browser.close(); } catch (error) { cleanupErrors.push(error.message); } }
  for (const [key, value] of Object.entries(originalTemporaryEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const run of processes.reverse()) { try { await stopProcess(run); } catch (error) { cleanupErrors.push(error.message); } }
  if (abort.signal.aborted) await delay(1200);
  if (isolation) {
    // PTY と Codex app-server は別のプロセス群になる。登録した偽 CLI だけを止める。
    for (const actor of await readActors(isolation.control)) {
      try {
        process.kill(actor.pid, 0);
        const command = execFileSync('ps', ['-p', String(actor.pid), '-o', 'command='], { encoding: 'utf8' });
        if (!command.includes(isolation.bin)) throw new Error(`PID ${actor.pid} の所有を確認できません`);
        process.kill(actor.pid, 'SIGTERM');
        await waitFor(() => { try { process.kill(actor.pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'fake CLI exit', 5000);
      } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error.message); }
    }
    try {
      const evidence = join(directory, 'fixture-evidence'); await mkdir(evidence, { recursive: true });
      // 合成データだけ残す。DB、認証 token、HOME 全体は保存しない。
      for (const [source, destination] of [[isolation.control, 'control'], [join(isolation.env.CLAUDE_CONFIG_DIR, 'projects'), 'claude'], [join(isolation.env.CODEX_HOME, 'sessions'), 'codex']]) {
        if (existsSync(source)) await cp(source, join(evidence, destination), { recursive: true });
      }
      await removeIsolation(isolation);
    } catch (error) { cleanupErrors.push(error.message); }
  }
  for (const log of logs) await new Promise(resolve => log.end(resolve));
  report.metadata.cleanup = { ok: cleanupErrors.length === 0, errors: cleanupErrors, runtimeRemoved: !isolation || !existsSync(isolation.root) };
  report.errors.push(...cleanupErrors.map(error => `後片付け: ${error}`));
  await report.save();
  console.log(`結果: ${join(directory, 'report.html')}`);
  console.log(`判定: ${report.passed() ? 'PASS' : 'FAIL（未実行も公開不可）'}`);
  process.exitCode = report.passed() ? 0 : 1;
}
