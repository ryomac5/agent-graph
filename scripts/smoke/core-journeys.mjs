// 本番のダッシュボードで、核の使い方を本物のブラウザで最初から最後まで通す。
// 本番に出すたびに `node scripts/smoke/core-journeys.mjs` で走らせる。1 つでも落ちたら終了コードは 1 になる。
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const PLAYWRIGHT = '/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = (process.env.AGENT_GRAPH_SMOKE_URL ?? 'http://127.0.0.1:7420').replace(/\/$/, '');
const STATE_DIR = join(homedir(), '.cache/agent-graph/smoke');
const SESSION_FILE = join(STATE_DIR, 'session.json');
const PROJECT_PATH = ROOT.replace(/\/$/, '');
const MODEL = 'haiku';
const REPLY_TIMEOUT_MS = 90_000;
const CHANGES_TIMEOUT_MS = 5_000;
const UI_TIMEOUT_MS = 20_000;
// 1x1 の赤い png。
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const UNSUPPORTED = ['この会話の履歴からは続きを始められません', 'Unable to continue from this conversation history'];
const SEND_COMMANDS = ['send', 'start', 'adopt', 'fork', 'session.launch', 'session.send'];
// 画面から本番へ流してよい読み取りの命令。書き込みはここに無いので、下の guard が止める。
const READ_COMMANDS = new Set(['session.hosts', 'list_models', 'usage.read', 'settings.read', 'settings.status', 'settings.models',
  'models.table', 'models.resolve', 'files.list', 'files.read', 'files.worktrees', 'files.changes', 'files.diff', 'files.commits',
  'files.commit', 'files.preview', 'git.branches', 'ssh.read', 'terminal.attach']);

let chromium;
try { ({ chromium } = await import(PLAYWRIGHT)); }
catch (error) {
  console.error(`Playwright was not found at ${PLAYWRIGHT}.`);
  console.error('Install it with `npx playwright@1.63.0 install chromium`, then update PLAYWRIGHT in this script.');
  console.error(`Cause: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const results = [];
let browser;
let page;
let current = 'setup';
const pageErrors = [];
// 確かめで生じた状態。後始末で使う。
const smoke = { id: '', native: '', project: '', created: false, renamed: false, phase: 'idle', launches: [], blocked: [], terminals: new Set(), launchCommands: new Set() };

function log(line) { process.stdout.write(`${line}\n`); }
async function waitFor(check, label, timeout = UI_TIMEOUT_MS, interval = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeout / 1000)}s: ${label}`);
    await delay(interval);
  }
}
async function readToken() {
  const html = await (await fetch(`${BASE}/`)).text();
  const token = /<meta name="agent-graph-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error('Dashboard token was not found in the page');
  return token;
}
async function snapshot() {
  const response = await fetch(`${BASE}/snapshot`, { headers: { 'x-agent-graph-token': await readToken() } });
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return response.json();
}
function nativeOf(id) { const value = JSON.parse(id); return Array.isArray(value) ? value[1] : ''; }
async function rememberSession() {
  await writeFile(SESSION_FILE, `${JSON.stringify({ conversationId: smoke.id, project: smoke.project, model: MODEL, createdAt: new Date().toISOString() }, null, 2)}\n`);
}
function stamp() { return new Date().toLocaleTimeString('ja-JP', { hour12: false }); }

// 画面の WebSocket を中継し、本番の台帳を書き換える命令は確かめの送信と名前の変更だけに絞る。
// 新しいセッションの作成の窓にはモデルの欄が無いので、確かめ用のセッションの起動にだけ haiku を足す。
function guard(ws) {
  const server = ws.connectToServer();
  // 起動の応答から端末を覚える。作成の途中で落ちても、後始末で閉じられるようにする。
  server.onMessage(message => {
    try {
      const parsed = JSON.parse(String(message));
      if (parsed?.type === 'ack' && smoke.launchCommands.has(parsed.cmd_id) && parsed.ok && parsed.result?.terminalId) smoke.terminals.add(parsed.result.terminalId);
    } catch { /* JSON でない応答はそのまま渡す。 */ }
    ws.send(message);
  });
  ws.onMessage(message => {
    let parsed;
    try { parsed = JSON.parse(String(message)); } catch { server.send(message); return; }
    if (parsed?.type !== 'cmd') { server.send(message); return; }
    const { command, payload = {} } = parsed;
    const helper = String(parsed.cmd_id).startsWith('smoke-helper-');
    let allowed = READ_COMMANDS.has(command) && command !== 'terminal.attach' || command === 'terminal.attach' && helper;
    if (command === 'session.launch' && payload.projectId === smoke.project && (payload.provider ?? 'claude') === 'claude' && !payload.worktree
      && (smoke.phase === 'create' && !payload.resume || smoke.native && payload.resume === smoke.native)) {
      parsed = { ...parsed, payload: { ...payload, model: MODEL } };
      smoke.launches.push(payload.resume ? 'resume' : 'create');
      smoke.launchCommands.add(parsed.cmd_id);
      allowed = true;
    }
    if (command === 'session.send' && smoke.id && payload.conversationId === smoke.id) allowed = true;
    if (command === 'attachment.put' && smoke.phase === 'image') allowed = true;
    if (command === 'session.rename' && smoke.id && payload.rootId === smoke.id) allowed = true;
    if (command === 'terminal.close' && helper && smoke.terminals.has(payload.terminalId)) allowed = true;
    if (!allowed) {
      smoke.blocked.push({ step: current, command, payload });
      ws.send(JSON.stringify({ type: 'ack', cmd_id: parsed.cmd_id, ok: false, error: 'Blocked by smoke guard' }));
      return;
    }
    server.send(JSON.stringify(parsed));
  });
}
// 画面と同じ起点から WebSocket を開き、命令を順に送る。端末の close は同じ接続での attach が要る。
async function helperCommands(commands) {
  return page.evaluate(async list => {
    const token = document.querySelector('meta[name="agent-graph-token"]').content;
    const state = await (await fetch('/snapshot', { headers: { 'x-agent-graph-token': token } })).json();
    const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('helper socket failed')); });
    socket.send(JSON.stringify({ type: 'hello', seq: state.seq, generation: state.generation, scope: { tables: [] } }));
    const acks = [];
    try {
      for (const [index, [command, payload]] of list.entries()) {
        const cmd_id = `smoke-helper-${Date.now()}-${index}`;
        acks.push(await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`helper ${command} timed out`)), 15000);
          socket.addEventListener('message', function listen(event) {
            const message = JSON.parse(event.data);
            if (message.type === 'ack' && message.cmd_id === cmd_id) { clearTimeout(timer); socket.removeEventListener('message', listen); resolve(message); }
          });
          socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload }));
        }));
      }
    } finally { socket.close(); }
    return acks;
  }, commands);
}
async function smokeHosts() {
  const [ack] = await helperCommands([['session.hosts', {}]]);
  if (!ack.ok) throw new Error(`session.hosts failed: ${ack.error}`);
  return (ack.result?.hosts ?? []).filter(host => smoke.id && host.conversationId === smoke.id || smoke.terminals.has(host.terminalId));
}
async function closeSmokeTerminals() {
  if (!page) return 0;
  const hosts = await smokeHosts();
  // 作成の途中で落ちたときも、起動した会話を覚えて次の回で呼び戻す。
  const orphan = !smoke.id && hosts.find(host => host.conversationId);
  if (orphan) { smoke.id = orphan.conversationId; smoke.native = nativeOf(smoke.id); await rememberSession(); }
  for (const host of hosts) {
    smoke.terminals.add(host.terminalId);
    const [attach, close] = await helperCommands([['terminal.attach', { terminalId: host.terminalId }], ['terminal.close', { terminalId: host.terminalId }]]);
    if (!attach.ok || !close.ok) throw new Error(`terminal.close failed: ${attach.error ?? close.error}`);
  }
  await waitFor(async () => (await smokeHosts()).length === 0, 'smoke terminal exit', 10_000);
  return hosts.length;
}

async function step(name, body) {
  current = name;
  const errorsBefore = pageErrors.length;
  const started = Date.now();
  let error;
  let detail = '';
  try { detail = await body() ?? ''; }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const fresh = pageErrors.slice(errorsBefore);
  if (fresh.length) error = `${error ? `${error}; ` : ''}page errors: ${fresh.join(' | ')}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name, ok: !error, seconds, errors: fresh.length });
  log(`${error ? 'FAIL' : 'PASS'}  ${name.padEnd(28)} ${seconds.padStart(6)}s  ${error ?? detail}`);
  if (error && page) {
    const file = join(STATE_DIR, `fail-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
    await page.screenshot({ path: file, fullPage: false }).then(() => log(`      screenshot: ${file}`), () => {});
  }
  return !error;
}

const active = () => page.locator('.workbench-body:not([hidden])').first();
const composer = () => active().locator('footer.composer');
const panel = () => page.getByRole('complementary', { name: 'Panel', exact: true });
async function openRoot(rootId, composerShown = true) {
  await page.goto(`${BASE}/p/${encodeURIComponent(smoke.project)}?root=${encodeURIComponent(rootId)}`);
  await page.locator('a.root-row[aria-current="page"]').waitFor({ timeout: UI_TIMEOUT_MS });
  if (composerShown) await composer().getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
}
// 会話の欄で、印の付いた人の発言より後に、OK を含む相手の発言が出るまで待つ。
async function waitReply(marker, timeout = REPLY_TIMEOUT_MS) {
  return waitFor(() => active().evaluate((element, text) => {
    const articles = [...element.querySelectorAll('article.message')];
    const index = articles.findLastIndex(article => article.dataset.side === 'end' && article.textContent.includes(text));
    return index >= 0 && articles.slice(index + 1).some(article => article.dataset.side !== 'end' && /(^|[^A-Za-z])OK([^A-Za-z]|$)/.test(article.textContent));
  }, marker), `reply with OK after "${marker}"`, timeout, 500);
}
// 画像が実際に描けたか。CSP で止められると naturalWidth が 0 のままになる。
async function loaded(image) {
  return waitFor(() => image.evaluate(element => element.complete && element.naturalWidth > 0), 'image load', 5_000).catch(() => false);
}
async function findTranscript(native) {
  const base = join(homedir(), '.claude/projects');
  for (const directory of await readdir(base)) {
    const file = join(base, directory, `${native}.jsonl`);
    if (await stat(file).then(() => true, () => false)) return file;
  }
  return '';
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  for (const file of await readdir(STATE_DIR)) if (/^fail-.*\.png$/.test(file)) await rm(join(STATE_DIR, file));
  const initial = await snapshot();
  const project = initial.projection.projects.find(row => row.root_path === PROJECT_PATH);
  if (!project) throw new Error(`Project ${PROJECT_PATH} is not registered in the dashboard`);
  smoke.project = String(project.id);
  const saved = await readFile(SESSION_FILE, 'utf8').then(JSON.parse, () => undefined);
  if (saved?.conversationId && initial.projection.roots.some(root => root.id === saved.conversationId)) {
    smoke.id = saved.conversationId; smoke.native = nativeOf(smoke.id);
  }
  const rootsBefore = initial.projection.roots.filter(root => root.project === smoke.project).length;

  browser = await chromium.launch({ headless: process.env.AGENT_GRAPH_SMOKE_HEADED !== '1' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.routeWebSocket(/\/ws(\?|$)/, guard);
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
  });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    const text = message.text();
    if (/Content Security Policy|CSP violation/i.test(text)) pageErrors.push(`csp: ${text.slice(0, 200)}`);
  });
  await page.goto(`${BASE}/`);
  await page.getByRole('navigation', { name: 'Projects' }).waitFor({ timeout: UI_TIMEOUT_MS });
  // 確かめの前の localStorage を覚え、最後に戻す。
  const storage = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));

  try {
    await step('1 send', async () => {
      if (!smoke.id) {
        smoke.phase = 'create';
        // 「+」はプロジェクトの行に指を載せたときだけ見える。
        const projectRow = page.locator('.sidebar-project-row').filter({ has: page.getByRole('link', { name: project.display_name, exact: true }) });
        await projectRow.hover();
        await projectRow.getByRole('button', { name: `New task: ${project.display_name}`, exact: true }).click();
        await page.getByRole('menuitem', { name: 'New session', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Claude' }).click();
        await dialog.getByRole('button', { name: /^Create/ }).click();
        await page.waitForURL(url => url.searchParams.has('conversation'), { timeout: 45_000 });
        smoke.id = new URL(page.url()).searchParams.get('conversation');
        smoke.native = nativeOf(smoke.id);
        smoke.created = true;
        await rememberSession();
        await composer().getByRole('textbox', { name: 'Message', exact: true }).waitFor({ timeout: UI_TIMEOUT_MS });
      } else await openRoot(smoke.id);
      smoke.phase = 'send';
      const marker = `確かめの ${stamp()}`;
      const text = `${marker}。OK とだけ返してください。`;
      await composer().getByRole('textbox', { name: 'Message', exact: true }).fill(text);
      const send = composer().getByRole('button', { name: 'Send', exact: true });
      await waitFor(() => send.isEnabled(), 'Send button enabled');
      const started = Date.now();
      await send.click();
      // 送った発言が画面に出る。
      await active().locator('article.message[data-side="end"]', { hasText: marker }).first().waitFor({ timeout: 10_000 });
      await waitReply(marker);
      const alert = await composer().getByRole('alert').allTextContents();
      if (alert.length) throw new Error(`composer alert: ${alert.join(' ')}`);
      return `${smoke.created ? 'created' : 'reused'} ${smoke.id}, reply in ${((Date.now() - started) / 1000).toFixed(1)}s, launches=${smoke.launches.join(',') || 'none'}`;
    });

    await step('2 send with image', async () => {
      if (!smoke.id) throw new Error('no smoke session');
      smoke.phase = 'image';
      const marker = `確かめの ${stamp()} 画像`;
      const box = composer().locator('.composer-box');
      const transfer = await page.evaluateHandle(data => {
        const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'smoke-red.png', { type: 'image/png' }));
        return transfer;
      }, RED_PNG);
      await box.dispatchEvent('dragenter', { dataTransfer: transfer });
      await box.dispatchEvent('dragover', { dataTransfer: transfer });
      await box.dispatchEvent('drop', { dataTransfer: transfer });
      const preview = box.locator('.composer-attachment img').first();
      await preview.waitFor({ timeout: 10_000 });
      // 入力欄の縮小が読み込めたかを覚える。読めなくても送信の確かめは続ける。
      const previewLoaded = await loaded(preview);
      await composer().getByRole('textbox', { name: 'Message', exact: true }).fill(`${marker}。OK とだけ返してください。`);
      const send = composer().getByRole('button', { name: 'Send', exact: true });
      await waitFor(() => send.isEnabled(), 'Send button enabled');
      await send.click();
      // 記録の発言に image の要素が入る。
      const transcript = await waitFor(() => findTranscript(smoke.native), 'transcript file', 30_000, 1000);
      await waitFor(async () => {
        const lines = (await readFile(transcript, 'utf8')).split('\n').filter(Boolean);
        return lines.some(line => {
          if (!line.includes(marker)) return false;
          const content = JSON.parse(line).message?.content;
          return Array.isArray(content) && content.some(block => block.type === 'image');
        });
      }, 'image block in transcript', 60_000, 1000);
      // 画面に縮小の画像が出る。
      const thumbnail = active().locator('article.message[data-side="end"]', { hasText: marker }).locator('.message-images img').first();
      await thumbnail.waitFor({ timeout: 30_000 });
      if (!await loaded(thumbnail)) throw new Error('thumbnail in the conversation did not load');
      await waitReply(marker);
      smoke.phase = 'idle';
      if (!previewLoaded) throw new Error('image preview in the message box did not load; transcript and conversation thumbnail are fine');
      return `image in ${transcript.replace(homedir(), '~')}`;
    });

    // 子の多い根を開く。グラフと Codex の子の確かめで使う。
    const parent = initial.projection.roots.filter(root => root.project === smoke.project && root.id !== smoke.id)
      .toSorted((a, b) => (b.total_children ?? 0) - (a.total_children ?? 0))[0];
    const tree = () => panel().getByRole('tree', { name: 'Request graph' });
    async function openParent() {
      if (!parent || !parent.total_children) throw new Error('no root with children in the project');
      await page.goto(`${BASE}/p/${encodeURIComponent(smoke.project)}?root=${encodeURIComponent(parent.id)}`);
      await panel().getByRole('tab', { name: 'Graph', exact: true }).click();
      await tree().waitFor({ timeout: UI_TIMEOUT_MS });
    }
    // 真ん中の選ばれたタブが子の会話に替わり、発言が出るまで待つ。
    // 行の aria-label の先頭は、実行中の行では題ではなく状態の語になることがある。題の文字では比べない。
    // 真ん中の選ばれたタブが、押す前と違う会話に替わり、その会話の発言が出ることで確かめる。
    async function waitForCenter(title, before) {
      const tab = page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab', { selected: true });
      await waitFor(async () => (await tab.textContent() ?? '') !== before, `child conversation "${title.slice(0, 30)}" in the center tab`);
      await active().locator('article.message').first().waitFor({ timeout: UI_TIMEOUT_MS });
    }
    // 子の行は、提供元の名前を名前に含む。日付の束の行は含まない。
    async function childRow(provider) {
      const pattern = new RegExp(` · (${provider}) · `);
      const rows = tree().getByRole('treeitem', { name: pattern });
      if (await rows.count()) return rows.first();
      for (const group of await tree().getByRole('treeitem', { name: /^(Today|Earlier|Yesterday)/ }).all()) {
        await group.click();
        if (await rows.count()) return rows.first();
      }
      throw new Error(`no ${provider} child row in the graph`);
    }

    await step('3 codex send path', async () => {
      await openParent();
      const row = await childRow('Codex');
      const title = (await row.getAttribute('aria-label') ?? await row.innerText()).split(' · ')[0];
      await row.click();
      await page.waitForURL(url => url.searchParams.get('child')?.startsWith('["codex"'), { timeout: UI_TIMEOUT_MS });
      const child = new URL(page.url()).searchParams.get('child');
      await waitForCenter(title);
      const input = composer().getByRole('textbox', { name: 'Message', exact: true });
      const draft = 'smoke: this message is blocked before it reaches Codex';
      await input.fill(draft);
      if (await input.inputValue() !== draft) throw new Error('Codex message box did not keep the typed text');
      const send = composer().getByRole('button', { name: 'Send', exact: true });
      await waitFor(() => send.isEnabled(), 'Codex Send button enabled', 10_000);
      // guard が送信の命令を止めるので、本物の Codex には届かない。押したときの経路だけを確かめる。
      const before = smoke.blocked.length;
      await send.click();
      await waitFor(async () => smoke.blocked.slice(before).some(row => SEND_COMMANDS.includes(row.command))
        || await page.getByText(new RegExp(UNSUPPORTED.join('|'))).count(), 'send command or warning after click', 10_000);
      const shown = await page.getByText(new RegExp(UNSUPPORTED.join('|'))).count();
      if (shown) throw new Error(`"${UNSUPPORTED[0]}" is shown after Send on ${child}`);
      const attempted = smoke.blocked.slice(before).find(row => SEND_COMMANDS.includes(row.command));
      const target = attempted.payload?.conversationId ?? attempted.payload?.resume;
      if (target !== child && target !== nativeOf(child)) throw new Error(`Send issued ${attempted.command} for ${target}, not ${child}`);
      await input.fill('');
      return `${title.slice(0, 30)}: Send enabled, click issued ${attempted.command} (blocked)`;
    });

    await step('4 graph', async () => {
      await openParent();
      const rootRow = tree().getByRole('treeitem', { level: 1 }).first();
      await rootRow.waitFor({ timeout: UI_TIMEOUT_MS });
      const row = await childRow('Claude|Codex');
      const label = await row.getAttribute('aria-label') ?? '';
      const title = label.split(' · ')[0];
      const before = await page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab', { selected: true }).textContent() ?? '';
      await row.click();
      await page.waitForURL(url => url.searchParams.has('child'), { timeout: UI_TIMEOUT_MS });
      await waitForCenter(title, before);
      const children = await tree().getByRole('treeitem', { level: 2 }).count();
      return `root + ${children} rows, opened "${title.slice(0, 30)}"`;
    });

    await step('5 changes', async () => {
      await openRoot(smoke.id, false);
      const started = Date.now();
      await panel().getByRole('tab', { name: 'Changes', exact: true }).click();
      await panel().getByRole('region', { name: 'Commits' }).getByRole('listitem').first().waitFor({ timeout: CHANGES_TIMEOUT_MS });
      return `first commit row in ${((Date.now() - started) / 1000).toFixed(1)}s`;
    });

    await step('6 files', async () => {
      await panel().getByRole('tab', { name: 'Files', exact: true }).click();
      const item = panel().getByRole('tree', { name: 'Files' }).getByRole('treeitem', { name: 'README.md', exact: true });
      await item.dblclick({ timeout: UI_TIMEOUT_MS });
      const tab = page.getByRole('tablist', { name: 'Workspace tabs' }).getByRole('tab', { name: /README\.md/ });
      await tab.waitFor({ timeout: UI_TIMEOUT_MS });
      const expected = (await readFile(join(ROOT, 'README.md'), 'utf8')).split('\n').find(line => line.length > 20 && !line.startsWith('#'));
      await active().getByText(expected.slice(0, 40)).first().waitFor({ timeout: UI_TIMEOUT_MS });
      return 'README.md opened in a code tab';
    });

    await step('7 rename', async () => {
      if (!smoke.id) throw new Error('no smoke session');
      await openRoot(smoke.id, false);
      const list = page.getByRole('region', { name: `${project.display_name} sessions` });
      const link = () => list.locator(`a.root-row[aria-current="page"]`);
      const original = await link().getAttribute('aria-label');
      const name = `smoke-${Date.now().toString(36)}`;
      await link().dblclick();
      const input = list.getByRole('textbox', { name: 'Rename', exact: true });
      await input.fill(name); await input.press('Enter');
      smoke.renamed = true;
      await list.getByRole('link', { name, exact: true }).waitFor({ timeout: 10_000 });
      await link().dblclick();
      await input.fill(''); await input.press('Enter');
      await list.getByRole('link', { name: original, exact: true }).waitFor({ timeout: 10_000 });
      smoke.renamed = false;
      return `"${original}" -> "${name}" -> "${original}"`;
    });

    await step('8 settings', async () => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.waitForURL(url => url.pathname === '/settings');
      await waitFor(async () => !(await page.getByText('Loading settings…').count()), 'settings loaded');
      await page.waitForTimeout(1000);
      const body = await page.locator('body').innerText();
      if (body.includes('Settings application failed')) throw new Error('"Settings application failed" is shown');
      const alerts = (await page.getByRole('alert').allTextContents()).filter(Boolean);
      return alerts.length ? `alerts: ${alerts.join(' | ')}` : 'no failure text';
    });
  } finally {
    current = 'cleanup';
    const notes = [];
    try {
      if (smoke.renamed) { const [ack] = await helperCommands([['session.rename', { rootId: smoke.id, name: '' }]]); notes.push(`name reset ${ack.ok ? 'ok' : ack.error}`); }
    } catch (error) { notes.push(`name reset failed: ${error.message}`); }
    try { notes.push(`closed ${await closeSmokeTerminals()} terminal(s)`); } catch (error) { notes.push(`terminal close failed: ${error.message}`); }
    try {
      await page.evaluate(entries => { localStorage.clear(); for (const [key, value] of JSON.parse(entries)) localStorage.setItem(key, value); }, storage);
      notes.push('localStorage restored');
    } catch (error) { notes.push(`localStorage restore failed: ${error.message}`); }
    await step('9 page errors', async () => {
      if (pageErrors.length) throw new Error(`${pageErrors.length} page error(s) in total: ${pageErrors.join(' | ')}`);
      return 'no pageerror and no CSP violation';
    });
    const after = await snapshot().catch(() => undefined);
    const rootsAfter = after?.projection.roots.filter(root => root.project === smoke.project).length;
    const unexpected = smoke.blocked.filter(row => row.step !== '3 codex send path').map(row => `${row.step}:${row.command}`);
    log(`----  cleanup: ${notes.join(', ')}`);
    log(`----  session ${smoke.id} (${smoke.created ? 'created this run' : 'reused'}), project roots ${rootsBefore} -> ${rootsAfter ?? '?'}`);
    if (unexpected.length) log(`----  guard blocked: ${unexpected.join(', ')}`);
    await browser?.close();
  }
}

try { await main(); }
catch (error) {
  results.push({ name: current, ok: false });
  log(`FAIL  ${current}: ${error instanceof Error ? error.stack : error}`);
  await browser?.close().catch(() => {});
}
const failed = results.filter(row => !row.ok);
log(`${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length}/${results.length} steps passed`);
process.exitCode = failed.length ? 1 : 0;
