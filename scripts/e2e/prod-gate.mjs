#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DIRECTORY, REPOSITORY, PLAYWRIGHT, createIsolation, removeIsolation, launch, stopProcess,
  runCommand, readJson, readActors, waitFor, verifyPtyHelper } from './isolation.mjs';
import { REPLY_PREFIX } from './fixtures.mjs';

const exec = promisify(execFile);
const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
const DEFAULTS = { 'rss-limit-mib': 1600, 'rss-slope-mib-min': 1, 'sample-ms': 5000,
  'observe-ms': 180_000, 'startup-timeout-ms': 20 * MINUTE_MS, 'send-timeout-ms': 120_000,
  'reconnect-timeout-ms': 30_000, 'locked-limit': 10 };
const HELP = `Usage: node scripts/e2e/prod-gate.mjs [options]
  --db-copy <path>             Read an existing copy instead of the production DB
  --headed                    Show Chromium
  --rss-limit-mib <n>          Maximum API RSS, including startup (default 1600)
  --rss-slope-mib-min <n>       Maximum post-startup OLS slope (default 1)
  --sample-ms <n>              RSS sampling interval (default 5000)
  --observe-ms <n>             Post-startup observation duration (default 180000)
  --startup-timeout-ms <n>     Startup/scan deadline (default 1200000)
  --send-timeout-ms <n>        Browser send/reply deadline (default 120000)
  --reconnect-timeout-ms <n>   Maximum continuous Reconnecting duration (default 30000)
  --locked-limit <n>           Allowed stderr occurrences (default 10)
  --help                      Print help without starting anything

Requires Node 24, sqlite3, ps, installed workspace dependencies and existing Playwright/Chromium.
Source DB is opened read-only with VACUUM INTO. All runtime files live under $TMPDIR
and are deleted on exit; --db-copy is never modified or deleted. JSON lines on stdout
contain checks and numeric measurements. No real Claude/Codex is started.
`;

export function parseOptions(args) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] === '--help' || args[i] === '--headed') { options[key] = true; continue; }
    if (args[i] === '--db-copy') {
      assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), '--db-copy requires a path');
      options.dbCopy = resolve(args[++i]); continue;
    }
    assert.ok(args[i].startsWith('--') && Object.hasOwn(DEFAULTS, key), `Unknown option: ${args[i]}`);
    const value = Number(args[++i]);
    assert.ok(Number.isFinite(value) && value >= 0, `Invalid ${key}`);
    options[key] = value;
  }
  for (const key of ['sample-ms', 'observe-ms', 'startup-timeout-ms', 'send-timeout-ms', 'reconnect-timeout-ms', 'rss-limit-mib']) {
    assert.ok(options[key] > 0, `${key} must be positive`);
  }
  assert.ok(Number.isSafeInteger(options['locked-limit']), 'locked-limit must be an integer');
  assert.ok(options['observe-ms'] >= 2 * options['sample-ms'], 'observe-ms needs at least three RSS samples');
  return options;
}

// 実測時刻を使った最小二乗法。採取不能を安定と扱わない。
export function calculateRssSlope(samples) {
  assert.ok(samples.length >= 3, 'At least three RSS samples required');
  for (let i = 0; i < samples.length; i++) {
    assert.ok(Number.isFinite(samples[i].atMs) && Number.isFinite(samples[i].rssBytes) && samples[i].rssBytes > 0);
    if (i) assert.ok(samples[i].atMs > samples[i - 1].atMs, 'Sample times must increase');
  }
  const first = samples[0].atMs;
  const meanX = samples.reduce((sum, s) => sum + (s.atMs - first) / MINUTE_MS, 0) / samples.length;
  const meanY = samples.reduce((sum, s) => sum + s.rssBytes / MIB, 0) / samples.length;
  let covariance = 0, variance = 0;
  for (const s of samples) {
    const x = (s.atMs - first) / MINUTE_MS - meanX;
    covariance += x * (s.rssBytes / MIB - meanY); variance += x * x;
  }
  return covariance / variance;
}

// chunk の境目や改行形式に依存せず、語句の出現をすべて数える。
export function countDatabaseLocked(chunks) {
  return (chunks.join('').match(/database is locked/gi) ?? []).length;
}

export function assessRss(samples, steadySinceMs, limitMiB, slopeLimit) {
  const steady = samples.filter(s => s.atMs >= steadySinceMs);
  const slopeMiBMin = calculateRssSlope(steady);
  const peakMiB = samples.reduce((peak, s) => Math.max(peak, s.rssBytes / MIB), 0);
  return { pass: peakMiB <= limitMiB && slopeMiBMin <= slopeLimit,
    peakMiB, slopeMiBMin, samples: samples.length, steadySamples: steady.length, limitMiB, slopeLimit };
}

async function runGate(options) {
  const results = new Map();
  const record = (check, pass, values = {}) => {
    const result = { ...values, check, pass }; results.set(check, result); console.log(JSON.stringify(result));
  };
  let isolation, browser, api, sampler, sampling = false, sampleError, stopping = false;
  let apiExit, steadySinceMs = Infinity, completed = false;
  const processes = [], samples = [], stderr = { api: [], runner: [] };
  const abort = new AbortController();
  const originalTmp = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]));
  const interrupt = () => abort.abort(new Error('Interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const guard = () => {
    abort.signal.throwIfAborted();
    if (apiExit) throw new Error(`API exited: ${JSON.stringify(apiExit)}`);
    if (sampleError) throw sampleError;
  };
  const wait = (check, label, timeout) => waitFor(async () => { guard(); return check(); }, label, timeout);
  const overall = setTimeout(() => abort.abort(new Error('Overall deadline exceeded')),
    2 * options['startup-timeout-ms'] + options['observe-ms'] + 4 * options['send-timeout-ms'] + 180_000);
  const closeBrowser = () => { void browser?.close().catch(() => {}); };
  abort.signal.addEventListener('abort', closeBrowser);
  async function sample() {
    if (sampling || stopping || !api?.child.pid) return;
    sampling = true;
    try {
      const { stdout } = await exec('/bin/ps', ['-p', String(api.child.pid), '-o', 'rss='], { timeout: 5000 });
      const rssBytes = Number(stdout.trim()) * 1024;
      assert.ok(Number.isFinite(rssBytes) && rssBytes > 0, 'API RSS unavailable');
      const value = { atMs: performance.now(), rssBytes }; samples.push(value);
      console.log(JSON.stringify({ metric: 'api-rss', ...value }));
    } catch (error) { if (!stopping) sampleError = error; }
    finally { sampling = false; }
  }
  try {
    isolation = await createIsolation(undefined, { temporary: true });
    isolation.env.E2E_PROD_GATE = '1';
    const source = await realpath(options.dbCopy ?? join(homedir(), '.local/state/agent-graph/agent-graph.db'));
    const target = join(isolation.state, 'agent-graph.db');
    const copyStarted = performance.now();
    // -readonly は元 DB を変更しない。VACUUM の書き込み先だけが使い捨て。
    await exec('sqlite3', ['-readonly', source, `VACUUM INTO '${target.replaceAll("'", "''")}';`],
      { env: isolation.env, cwd: isolation.root, timeout: options['startup-timeout-ms'], signal: abort.signal });
    console.log(JSON.stringify({ metric: 'db-copy', elapsedMs: performance.now() - copyStarted }));
    const { DatabaseSync } = await import('node:sqlite');
    const { TIMESTAMP_REPAIR_ID } = await import(pathToFileURL(join(REPOSITORY, 'packages/core/src/ledger/normalize-timestamps.ts')).href);
    const db = new DatabaseSync(target);
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ledger_repairs'").get()) {
        db.prepare('DELETE FROM ledger_repairs WHERE id = ?').run(TIMESTAMP_REPAIR_ID);
      }
    } finally { db.close(); }
    await runCommand('/usr/bin/git', ['init', '--initial-branch=main', isolation.project],
      { cwd: isolation.root, env: isolation.env, signal: abort.signal });
    const require = createRequire(join(REPOSITORY, 'packages/dashboard/package.json'));
    const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
    await runCommand(process.execPath, [vite, 'build', '--configLoader', 'native', '--config',
      join(REPOSITORY, 'packages/dashboard/vite.config.ts'), '--outDir', isolation.dist],
    { cwd: isolation.project, env: isolation.env, signal: abort.signal });
    await verifyPtyHelper(); guard();
    function start(role) {
      const run = launch(process.execPath, [join(DIRECTORY, 'services.mjs'), role], { cwd: isolation.state, env: isolation.env });
      processes.push(run);
      run.child.stderr.on('data', chunk => stderr[role].push(chunk.toString()));
      return run;
    }
    async function ready(run, role) {
      return wait(async () => {
        if (run.child.exitCode !== null || run.child.signalCode !== null || !run.child.pid) throw new Error(`${role} failed to start`);
        return readJson(join(isolation.root, `${role}-ready.json`));
      }, `${role} ready`, options['startup-timeout-ms']);
    }
    const runner = start('runner'); await ready(runner, 'runner');
    const startMs = performance.now(); api = start('api');
    void api.closed.then(value => { if (!stopping) apiExit = value; });
    sampler = setInterval(() => void sample(), options['sample-ms']); await sample();
    const address = await ready(api, 'api');
    console.log(JSON.stringify({ metric: 'api-ready', elapsedMs: performance.now() - startMs }));
    for (const key of Object.keys(originalTmp)) process.env[key] = isolation.tmp;
    const { chromium } = await import(PLAYWRIGHT);
    browser = await chromium.launch({ headless: !options.headed, executablePath: chromium.executablePath(), env: isolation.env });
    const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
    const origin = new URL(address.url).origin;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin
      ? route.continue() : route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.protocol === 'ws:' && url.host === new URL(origin).host) socket.connectToServer();
      else socket.close();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(options['send-timeout-ms']);
    await page.addInitScript(() => {
      window.__gateConnection = { since: null, maxMs: 0, seen: false };
      setInterval(() => {
        const state = window.__gateConnection;
        const reconnecting = /\bReconnecting\b/.test(document.body?.innerText ?? '');
        if (reconnecting) {
          state.seen = true; state.since ??= performance.now();
          state.maxMs = Math.max(state.maxMs, performance.now() - state.since);
        } else state.since = null;
      }, 100);
    });
    await page.goto(origin, { timeout: options['startup-timeout-ms'] });
    // 初回走査と並行して、実際の画面から起動・送信する。
    const sendStarted = performance.now();
    const sendTask = (async () => {
      await page.getByRole('button', { name: 'Add project', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add project', exact: true });
      await dialog.getByRole('combobox', { name: 'Location', exact: true }).fill(isolation.project);
      await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
      await page.evaluate(() => localStorage.setItem('agent-graph-session-provider', 'claude'));
      const row = page.locator('.sidebar-project-row').filter({ has: page.locator('button[aria-label="Start conversation: journey-project"]') });
      await row.hover();
      await row.getByRole('button', { name: 'Start conversation: journey-project', exact: true }).click();
      await wait(async () => (await readActors(isolation.control)).some(a => a.provider === 'claude' && a.id), 'fake Claude start', options['send-timeout-ms']);
      const composer = page.locator('.workbench-body:not([hidden]) footer.composer').first();
      const marker = `prod-gate-${process.pid}-${Date.now()}`;
      await composer.getByRole('textbox', { name: 'Message', exact: true }).fill(marker);
      await composer.getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('.workbench-body:not([hidden]) article.message:not([data-side="end"]) .markdown-body')
        .filter({ hasText: REPLY_PREFIX + marker }).waitFor();
      const events = (await readFile(join(isolation.control, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(events.some(e => e.provider === 'claude' && e.event === 'reply' && e.text === marker));
      record('send', true, { elapsedMs: performance.now() - sendStarted });
    })().catch(error => record('send', false, { elapsedMs: performance.now() - sendStarted, error: error.message }));
    const scan = await wait(() => readJson(join(isolation.root, 'startup-scan.json')), 'startup reread', options['startup-timeout-ms']);
    const repair = stderr.api.join('').split('\n').filter(line => line.startsWith('{')).map(line => {
      try { return JSON.parse(line); } catch { return {}; }
    }).find(event => event.type === 'timestamps-repaired');
    record('startup-reread', scan.state === 'idle' && !!repair,
      { ...scan, repairElapsedMs: repair?.elapsed_ms ?? null, totalElapsedMs: performance.now() - startMs });
    await sendTask;
    steadySinceMs = performance.now(); await sample();
    const end = steadySinceMs + options['observe-ms'];
    while (performance.now() < end) { guard(); await delay(Math.min(250, end - performance.now())); }
    await wait(() => !sampling, 'RSS sampler idle', 6000); await sample(); guard();
    const connection = await page.evaluate(() => ({ ...window.__gateConnection,
      reconnecting: /\bReconnecting\b/.test(document.body.innerText) }));
    record('connection', !connection.reconnecting && connection.maxMs <= options['reconnect-timeout-ms'],
      { ...connection, limitMs: options['reconnect-timeout-ms'] });
    completed = true;
  } catch (error) {
    record('execution', false, { error: error.message });
  } finally {
    clearTimeout(overall); clearInterval(sampler);
    record('api-alive', completed && !!api && !apiExit && api.child.exitCode === null && api.child.signalCode === null,
      { pid: api?.child.pid ?? null, exit: apiExit ?? null });
    stopping = true;
    try {
      const rss = assessRss(samples, steadySinceMs, options['rss-limit-mib'], options['rss-slope-mib-min']);
      record('rss', !sampleError && rss.pass, { ...rss, error: sampleError?.message });
    } catch (error) { record('rss', false, { samples: samples.length, error: error.message }); }
    const errors = [];
    if (browser) await browser.close().catch(e => errors.push(e.message));
    for (const run of processes.reverse()) await stopProcess(run).catch(e => errors.push(e.message));
    const counts = Object.fromEntries(Object.entries(stderr).map(([role, chunks]) => [role, countDatabaseLocked(chunks)]));
    const locked = counts.api + counts.runner;
    record('database-locked', !!api && locked <= options['locked-limit'], { count: locked, ...counts, limit: options['locked-limit'] });
    for (const [key, value] of Object.entries(originalTmp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (isolation) {
      // PTY は別のプロセス群になる。記録だけで PID を信用せず、実行パスも照合する。
      try {
        for (const actor of await readActors(isolation.control)) {
          try {
            process.kill(actor.pid, 0);
            const { stdout } = await exec('/bin/ps', ['-p', String(actor.pid), '-o', 'command='], { timeout: 5000 });
            assert.ok(stdout.includes(isolation.bin), `Cannot verify fake CLI PID ${actor.pid}`);
            process.kill(actor.pid, 'SIGTERM');
            await waitFor(() => {
              try { process.kill(actor.pid, 0); return false; }
              catch (error) { if (error.code === 'ESRCH') return true; throw error; }
            }, 'fake CLI exit', 5000);
          } catch (error) { if (error.code !== 'ESRCH') errors.push(error.message); }
        }
      } catch (error) { errors.push(error.message); }
      await removeIsolation(isolation).catch(e => errors.push(e.message));
    }
    record('cleanup', errors.length === 0, { errors });
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    abort.signal.removeEventListener('abort', closeBrowser);
    for (const check of ['startup-reread', 'send', 'connection']) {
      if (!results.has(check)) record(check, false, { error: 'Not completed' });
    }
    const pass = [...results.values()].every(r => r.pass);
    console.log(JSON.stringify({ check: 'prod-gate', pass }));
    process.exitCode = pass ? 0 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP); else await runGate(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
