#!/usr/bin/env node
// ブラウザの経路で、api だけを再起動しても端末（偽 claude）と会話が残るかを実測する。
// 隔離した runner と api を立て、playwright の chromium で project 追加、会話の起動、送信を画面から行う。
// --negative を付けると負の対照になる。runner と偽 claude を止め、api だけ起動して同じ検査を行い、検査が FAIL になることを示す。
// api は固定のポート（E2E_DASHBOARD_PORT）で起動し直し、page.reload() で読み込み直す。
// E2E_CODE_ROOT で試す版を指定できる。失敗時の画面は E2E_SHOT_DIR（未指定なら ./restart-browser-shots）へ保存する。
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DIRECTORY, REPOSITORY, PLAYWRIGHT, createIsolation, launch, runCommand, stopProcess, removeIsolation, readActors, readJson, waitFor, verifyPtyHelper, START_TIMEOUT_MS, TIMEOUT_MS } from './isolation.mjs';
import { REPLY_PREFIX } from './fixtures.mjs';

const negative = process.argv.includes('--negative');
const shots = process.env.E2E_SHOT_DIR || join(process.cwd(), 'restart-browser-shots');
await mkdir(shots, { recursive: true });
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const isolation = await createIsolation();
const processes = [], logs = [];
let dashboardPort;
const track = role => {
  const log = createWriteStream(join(shots, `${role}-${processes.length}.log`)); logs.push(log);
  const run = launch(process.execPath, [join(DIRECTORY, 'services.mjs'), role], { cwd: isolation.state, env: { ...isolation.env, ...(dashboardPort ? { E2E_DASHBOARD_PORT: String(dashboardPort) } : {}) }, log }); run.role = role; processes.push(run); return run;
};
async function ready(run, file, notPid) {
  return waitFor(async () => {
    if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`startup failed: ${run.output()}`);
    const value = await readJson(join(isolation.root, file));
    return value && value.pid !== notPid ? value : undefined;
  }, file, START_TIMEOUT_MS);
}
const freePort = () => new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
// 同じポートの再利用で bind に失敗したら、短く待って起動し直す。
async function startApi(notPid) {
  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const run = track('api');
    try { return { run, address: await ready(run, 'api-ready.json', notPid) }; }
    catch (error) { last = error; console.log(`api start attempt ${attempt} failed: ${String(error.message).slice(0, 200)}`); await stopProcess(run).catch(() => {}); await delay(1000); }
  }
  throw last;
}
const ppidOf = pid => { try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()); } catch { return NaN; } };
let browser, page, step = 'setup';
const shot = async name => { try { await page?.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); console.log(`screenshot: ${join(shots, name + '.png')}`); } catch (e) { console.error('screenshot failed:', e.message); } };
try {
  await runCommand('/usr/bin/git', ['init', '--initial-branch=main', isolation.project], { cwd: isolation.root, env: isolation.env });
  const require = createRequire(join(REPOSITORY, 'packages/dashboard/package.json'));
  const vite = join(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
  await runCommand(process.execPath, [vite, 'build', '--configLoader', 'native', '--config', join(REPOSITORY, 'packages/dashboard/vite.config.ts'), '--outDir', isolation.dist], { cwd: isolation.project, env: isolation.env });
  await verifyPtyHelper();
  dashboardPort = await freePort();
  const runner = track('runner'); const runnerReady = await ready(runner, 'runner-ready.json');
  let { run: api, address } = await startApi();
  assert(new URL(address.url).port === String(dashboardPort), 'dashboard port is not fixed');
  const origin = new URL(address.url).origin;
  console.log(`runner pid ${runnerReady.pid}, api pid ${address.pid}, ${origin}`);
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = isolation.tmp;
  const { chromium } = await import(PLAYWRIGHT);
  browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), env: isolation.env });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
  await context.route('**/*', route => { const t = new URL(route.request().url()); return t.origin === origin || ['data:', 'blob:'].includes(t.protocol) ? route.continue() : route.abort('blockedbyclient'); });
  page = await context.newPage(); page.setDefaultTimeout(TIMEOUT_MS); page.setDefaultNavigationTimeout(START_TIMEOUT_MS);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const active = () => page.locator('.workbench-body:not([hidden])').filter({ has: page.locator('footer.composer') }).first();
  const composer = () => active().locator('footer.composer');
  const message = text => composer().getByRole('textbox', { name: 'Message', exact: true });
  const reply = text => active().locator('article.message:not([data-side="end"]) .markdown-body', { hasText: REPLY_PREFIX + text }).first().waitFor();
  const send = async text => { await message().fill(text); await composer().getByRole('button', { name: 'Send', exact: true }).click(); await reply(text); };

  // (1) project 追加、会話の起動、送信を画面で行う
  step = '(1) project 追加'; await page.goto(origin);
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add project', exact: true });
  await dialog.getByRole('combobox', { name: 'Location', exact: true }).fill(isolation.project);
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  const start = page.locator('.sidebar-project-row').filter({ has: page.locator('button[aria-label="Start conversation: journey-project"]') });
  await start.waitFor();
  step = '(1) 会話の起動'; await page.evaluate(() => localStorage.setItem('agent-graph-session-provider', 'claude'));
  await start.hover(); await start.getByRole('button', { name: 'Start conversation: journey-project', exact: true }).click();
  const actor = await waitFor(async () => (await readActors(isolation.control)).find(a => a.provider === 'claude' && a.id), 'fake claude', START_TIMEOUT_MS);
  await message().waitFor();
  step = '(1) 送信'; await send('BEFORE-RESTART');
  const conversationUrl = page.url();
  check('(1) 画面から project 追加、会話の起動、送信、返事', true, conversationUrl);
  // (2) pid を記録する。偽 claude の親が runner であることも記録する（api の子ではない）
  const parentBefore = ppidOf(actor.pid);
  console.log(`fake claude pid ${actor.pid}, ppid ${parentBefore}, runner pid ${runnerReady.pid}, api pid ${address.pid}`);
  check('(2) 偽 claude の ppid が runner の pid（再起動前）', parentBefore === runnerReady.pid, `ppid ${parentBefore}, runner ${runnerReady.pid}`);
  // (3) api だけを止めて起動し直す。--negative では runner と偽 claude も止め、端末が切れた状態を作る。
  step = '(3) api の再起動'; await stopProcess(api); await delay(500);
  if (negative) {
    await stopProcess(runner).catch(() => {});
    try { process.kill(actor.pid, 'SIGKILL'); } catch {}
    await delay(500);
  }
  console.log(`api stopped: fake claude alive=${alive(actor.pid)}, runner alive=${alive(runnerReady.pid)}`);
  ({ run: api, address } = await startApi(address.pid));
  console.log(`api restarted: new api pid ${address.pid}, ${address.url} (same url: ${new URL(address.url).origin === origin})`);
  check('(3) 再起動の前後で同じ URL', new URL(address.url).origin === origin, address.url);
  // (4) 画面の再読み込み（同じ URL のまま）
  step = '(4) 再読み込み'; await page.reload();
  const fail = async (id, message) => { check(id, false, message); };
  const pass = id => check(id, true);
  const rowText = async () => (await page.locator('.sidebar-roots').innerText().catch(() => '')).replace(/\s+/g, ' ');
  const BAD_ROW = /\b(Closed|Not hosted|Stopped|Unknown|Unresolved)\b/;
  const waitMs = negative ? 8_000 : 30_000;
  await message().waitFor({ timeout: waitMs }).catch(() => {});
  await page.waitForFunction(() => !/Reconnecting|Runner offline/.test(document.body.innerText), null, { timeout: waitMs }).then(() => pass('(4a) Reconnecting と Runner offline が消えた'), () => fail('(4a) Reconnecting と Runner offline が消えた', 'still shown'));
  await reply('BEFORE-RESTART').then(() => pass('(4b) 同じ会話が画面に残る'), () => fail('(4b) 同じ会話が画面に残る', 'BEFORE-RESTART の返事が見えない'));
  // 端末の失敗表示。サイドバー行の状態名（Closed、Not hosted、Stopped、Unknown）、Loading…、無効なメッセージ欄を見る。
  let settled = '';
  for (let i = 0; i < waitMs / 1000; i++) { settled = await rowText(); if (settled && !BAD_ROW.test(settled)) break; await delay(1000); }
  const badRow = BAD_ROW.exec(settled)?.[0];
  if (badRow || !settled) await fail('(4c) 会話の行が Closed / Not hosted / Stopped / Unknown でない', `row text: ${settled.slice(0, 200)}`); else pass('(4c) 会話の行が Closed / Not hosted / Stopped / Unknown でない');
  const loading = await page.getByText(/Loading…/).count();
  if (loading || /Not enabled/.test(await page.evaluate(() => document.body.innerText))) await fail('(4d) Loading… と Not enabled が出ていない', `Loading… ${loading}`); else pass('(4d) Loading… と Not enabled が出ていない');
  const box = message();
  const enabled = await box.isEnabled().catch(() => false);
  if (!enabled) await fail('(4e) メッセージ欄が有効', 'textarea is disabled or missing'); else {
    await box.fill('AFTER-RESTART');
    const sendEnabled = await composer().getByRole('button', { name: 'Send', exact: true }).isEnabled().catch(() => false);
    if (sendEnabled) pass('(4e) メッセージ欄が有効で、送信ボタンが押せる'); else await fail('(4e) メッセージ欄が有効で、送信ボタンが押せる', 'Send is disabled');
  }
  const terminalButton = page.locator('section.workbench-pane').filter({ has: active() }).locator('header.workbench-tabs').getByRole('button', { name: 'Terminal', exact: true });
  const terminalOk = await terminalButton.isEnabled({ timeout: 2000 }).catch(() => false);
  if (terminalOk) { await terminalButton.click(); await page.locator('.workbench-body:not([hidden]) .xterm-helper-textarea').waitFor({ state: 'attached', timeout: 10_000 }).then(() => pass('(4f) 端末タブが開く'), () => fail('(4f) 端末タブが開く', 'xterm not attached')); }
  else await fail('(4f) 端末タブが開く', 'Terminal button disabled or missing');
  // 端末タブの失敗表示。壊れた画面では「Terminal unavailable」「Exited.」、メッセージ欄に「Runner unavailable」が出る。
  await delay(2000);
  const screenText = await page.evaluate(() => document.body.innerText);
  const broken = /Terminal unavailable|Exited\.|Runner unavailable|Terminal request failed/.exec(screenText)?.[0];
  if (broken) await fail('(4h) 端末の失敗表示（Terminal unavailable、Exited.、Runner unavailable）が出ていない', `shown: ${broken}`); else pass('(4h) 端末の失敗表示（Terminal unavailable、Exited.、Runner unavailable）が出ていない');
  step = '(4) 再送信';
  if (enabled && terminalOk) {
    await page.locator('section.workbench-pane').filter({ has: page.locator('footer.composer') }).first().locator('header.workbench-tabs').getByRole('tab').first().click().catch(() => {});
    await composer().getByRole('button', { name: 'Send', exact: true }).click().catch(() => {});
    await reply('AFTER-RESTART').then(() => pass('(4g) 再び送信して返事が出る'), async e => { await shot('after-send-failed'); await fail('(4g) 再び送信して返事が出る', e.message); });
  } else await fail('(4g) 再び送信して返事が出る', '前の検査が失敗したため送れない');
  // (5) pid と親
  const parentAfter = ppidOf(actor.pid);
  console.log(`after restart: fake claude pid ${actor.pid} alive=${alive(actor.pid)}, ppid ${parentAfter}, runner pid ${runnerReady.pid} alive=${alive(runnerReady.pid)}, api pid ${address.pid}`);
  const after = (await readActors(isolation.control)).find(a => a.id === actor.id);
  check('(5) 偽 claude の pid が同じ', alive(actor.pid) && after?.pid === actor.pid, `pid ${actor.pid}`);
  check('(5c) 偽 claude の ppid が runner の pid のまま（api の子ではない）', parentAfter === runnerReady.pid && parentAfter !== address.pid, `ppid ${parentAfter}, runner ${runnerReady.pid}, api ${address.pid}`);
  check('pageerror なし', errors.length === 0, errors.join(' | '));
  if (results.some(r => !r.ok)) await shot('final');
} catch (error) {
  console.error(`落ちた手順: ${step}`); console.error(error.stack ?? error); check('実行', false, `${step}: ${error.message}`); await shot('failure');
} finally {
  if (results.some(r => !r.ok)) for (const run of processes) console.error(`--- ${run.role} output ---\n${run.output().slice(-3000)}`);
  if (browser) await browser.close().catch(() => {});
  for (const run of processes.reverse()) await stopProcess(run).catch(() => {});
  for (const a of await readActors(isolation.control).catch(() => [])) {
    try { if (alive(a.pid) && execFileSync('ps', ['-p', String(a.pid), '-o', 'command=']).toString().includes(isolation.bin)) process.kill(a.pid, 'SIGTERM'); } catch {}
  }
  await delay(500);
  for (const log of logs) await new Promise(r => log.end(r));
  await removeIsolation(isolation).catch(error => console.error('cleanup:', error.message));
  const ok = results.length > 0 && results.every(r => r.ok);
  console.log(`判定: ${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}
