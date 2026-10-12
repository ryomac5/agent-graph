import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PERF, REPEATS, summarize } from './baseline.mjs';

const BASE = process.env.AGENT_GRAPH_PERF_URL ?? 'http://127.0.0.1:7420';
const PLAYWRIGHT = process.env.AGENT_GRAPH_PERF_PLAYWRIGHT ?? '/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs';
const TIMEOUT = 30000;
const READ_COMMANDS = new Set(['session.hosts', 'list_models', 'usage.read', 'settings.read', 'settings.status', 'settings.models', 'models.table', 'models.resolve', 'files.list', 'files.read', 'files.worktrees', 'files.changes', 'files.diff', 'files.commits', 'files.commit', 'files.preview', 'git.branches', 'ssh.read']);
const result = {};
async function attempt(name, action) {
  try { result[name] = await action(); }
  catch (error) { result[name] = { unavailable: error.message + (error.cause ? `: ${error.cause.message}` : '') }; }
}
function readProcess(pid) {
  const line = execFileSync('ps', ['-p', String(pid), '-o', 'time=,rss='], { encoding: 'utf8' }).trim();
  const [time, rss] = line.split(/\s+/);
  const parts = time.split(':').map(Number);
  return { seconds: parts.reduce((sum, v) => sum * 60 + v, 0), rssBytes: Number(rss) * 1024 };
}
await attempt('processIdle', async () => {
  const pids = execFileSync('lsof', ['-t', '-iTCP:7420', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n');
  if (pids.length !== 1) throw new Error('Expected one listening api process');
  const pid = Number(pids[0]);
  const first = readProcess(pid); const start = performance.now(); const memory = [];
  for (let i = 0; i < 10; i++) { await delay(1000); memory.push(readProcess(pid).rssBytes); }
  const last = readProcess(pid); const wallMs = performance.now() - start;
  return { pid, n: 10, wallMs, cpuPercentOneCore: (last.seconds - first.seconds) * 100000 / wallMs, rss: summarize(memory), note: 'No browser from this script during sample; other user activity is not controlled' };
});
let browser;
await attempt('dashboard', async () => {
  const html = await (await fetch(BASE, { signal: AbortSignal.timeout(5000) })).text();
  const token = /<meta name="agent-graph-token" content="([^"]+)"/.exec(html)?.[1];
  if (!token) throw new Error('Dashboard token missing');
  const response = await fetch(BASE + '/snapshot', { headers: { 'x-agent-graph-token': token }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  const snapshot = await response.json();
  const selected = JSON.parse(await readFile(join(PERF, 'ledger.json'), 'utf8')).selected;
  const saved = await readFile(join(homedir(), '.cache/agent-graph/smoke/session.json'), 'utf8').then(JSON.parse, () => undefined);
  const smoke = saved && snapshot.projection.roots.some(r => r.id === saved.conversationId) ? saved : undefined;
  const terminals = new Set();
  const launches = new Set();
  const blocked = [];
  const { chromium } = await import(PLAYWRIGHT);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.routeWebSocket(/\/ws(\?|$)/, ws => {
    const server = ws.connectToServer();
    server.onMessage(message => {
      const data = JSON.parse(String(message));
      if (data.type === 'ack' && launches.has(data.cmd_id) && data.ok && data.result?.terminalId) terminals.add(data.result.terminalId);
      ws.send(message);
    });
    ws.onMessage(message => {
      let data = JSON.parse(String(message));
      if (data.type !== 'cmd') { server.send(message); return; }
      const { command, payload = {} } = data;
      let allowed = READ_COMMANDS.has(command);
      if (command === 'session.send' && smoke && payload.conversationId === smoke.conversationId) allowed = true;
      if (command === 'session.launch' && smoke && payload.projectId === smoke.project && payload.resume === JSON.parse(smoke.conversationId)[1] && !payload.worktree && (payload.provider ?? 'claude') === 'claude') {
        allowed = true; launches.add(data.cmd_id); data = { ...data, payload: { ...payload, model: 'haiku' } };
      }
      if (['terminal.attach', 'terminal.close'].includes(command) && String(data.cmd_id).startsWith('perf-cleanup-') && terminals.has(payload.terminalId)) allowed = true;
      if (!allowed) { blocked.push(command); ws.send(JSON.stringify({ type: 'ack', cmd_id: data.cmd_id, ok: false, error: 'Blocked by perf guard' })); return; }
      server.send(JSON.stringify(data));
    });
  });
  await context.addInitScript(() => {
    const metrics = window.__perf = { commits: 0, workFibers: 0, longTasks: [], frames: [] };
    // commit 数を再描画の指標にし、開発ビルドへ入れ替えない。
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1, onCommitFiberUnmount() {}, onCommitFiberRoot(id, root) {
      metrics.commits++;
      const visit = fiber => { if (!fiber) return; if (fiber.flags & 1) metrics.workFibers++; visit(fiber.child); visit(fiber.sibling); };
      visit(root.current);
    } };
    new PerformanceObserver(list => metrics.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const wsFrames = [];
  cdp.on('Network.webSocketFrameReceived', event => wsFrames.push({ ms: performance.now(), bytes: event.response.opcode === 2 ? Buffer.from(event.response.payloadData, 'base64').length : Buffer.byteLength(event.response.payloadData) }));
  const active = () => page.locator('.workbench-body:not([hidden])').first();
  async function painted() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function lastVisible() {
    await page.waitForFunction(() => {
      const root = document.querySelector('.workbench-body:not([hidden])');
      const box = root?.querySelector('.conv-timeline');
      const article = [...root?.querySelectorAll('article.message') ?? []].at(-1);
      if (!box || !article || root.querySelector('.history-loading')) return false;
      const a = article.getBoundingClientRect(), b = box.getBoundingClientRect();
      return a.bottom > b.top && a.top < b.bottom;
    });
    await painted();
  }
  const cold = [];
  for (let i = 0; i < REPEATS; i++) {
    const start = performance.now(); await page.goto(BASE);
    await page.getByRole('navigation', { name: 'Projects' }).waitFor();
    await painted();
    cold.push({ ms: performance.now() - start, resources: await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\.(js|css)(\?|$)/.test(r.name)).map(r => ({ path: new URL(r.name).pathname, transferBytes: r.transferSize, encodedBytes: r.encodedBodySize, decodedBytes: r.decodedBodySize }))) });
  }
  const opens = [];
  for (const [kind, row] of Object.entries(selected)) {
    const times = [];
    const requests = [];
    for (let i = 0; i < REPEATS; i++) {
      const frameStart = wsFrames.length;
      const start = performance.now(); await page.goto(`${BASE}/c/${encodeURIComponent(row.id)}`); await lastVisible(); times.push(performance.now() - start);
      requests.push({ firstWsFrameBytes: wsFrames[frameStart]?.bytes ?? null, resources: await page.evaluate(() => performance.getEntriesByType('resource').filter(r => new URL(r.name).pathname === '/conversation').map(r => ({ transferBytes: r.transferSize, encodedBytes: r.encodedBodySize, ms: r.duration }))) });
    }
    opens.push({ kind, id: row.id, messages: row.count, time: summarize(times), requests });
  }
  await page.goto(`${BASE}/p/${encodeURIComponent(smoke?.project ?? snapshot.projection.roots.find(r => r.project)?.project)}?root=${encodeURIComponent(selected.long.id)}`);
  await page.locator('a.root-row').first().waitFor();
  const switches = [];
  const roots = await page.locator('a.root-row').evaluateAll(nodes => nodes.slice(0, 2).map(n => n.getAttribute('href')));
  if (roots.length < 2) throw new Error('Two sidebar roots required for switch measurement');
  await page.locator('a.root-row').evaluateAll((nodes, target) => nodes.find(n => n.getAttribute('href') === target).click(), roots[0]);
  await lastVisible();
  for (let i = 0; i < REPEATS; i++) {
    const href = roots[(i + 1) % 2];
    const start = performance.now();
    await page.locator('a.root-row').evaluateAll((nodes, target) => nodes.find(n => n.getAttribute('href') === target).click(), href);
    await page.waitForURL(url => url.pathname + url.search === href);
    await page.locator('a.root-row[aria-current="page"]').waitFor();
    const sidebarMs = performance.now() - start;
    await lastVisible(); switches.push({ href, sidebarMs, lastMessageMs: performance.now() - start });
  }
  await page.goto(`${BASE}/c/${encodeURIComponent(selected.long.id)}`); await lastVisible();
  const scroll = [];
  for (let i = 0; i < REPEATS; i++) {
    scroll.push(await page.evaluate(async () => {
      const box = document.querySelector('.workbench-body:not([hidden]) .conv-timeline');
      const m = window.__perf; const commits = m.commits, work = m.workFibers, task = m.longTasks.length;
      const deltas = []; let previous = performance.now(); const start = previous;
      for (let step = 0; step < 120; step++) {
        box.scrollTop = Math.max(0, box.scrollTop - 150); box.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(now => { deltas.push(now - previous); previous = now; resolve(); }));
      }
      return { ms: performance.now() - start, frames: deltas, commits: m.commits - commits, workFibers: m.workFibers - work, longTasks: m.longTasks.slice(task), messages: box.querySelectorAll('article.message').length };
    }));
    await page.waitForFunction(() => !document.querySelector('.workbench-body:not([hidden]) .history-loading'));
  }
  const wsStart = wsFrames.length; const startWs = performance.now(); await delay(10000);
  const frames = wsFrames.slice(wsStart); const wsMs = performance.now() - startWs;
  const dashboard = { cold: { time: summarize(cold.map(c => c.ms)), runs: cold }, opens, switches, scroll, websocket: { wallMs: wsMs, frames: frames.length, bytes: frames.reduce((sum, f) => sum + f.bytes, 0), framesPerSecond: frames.length / (wsMs / 1000) }, blocked };
  async function cleanup() {
    if (!terminals.size) return;
    const acks = await page.evaluate(async ids => {
      const token = document.querySelector('meta[name="agent-graph-token"]').content;
      const state = await (await fetch('/snapshot', { headers: { 'x-agent-graph-token': token } })).json();
      const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
      await new Promise(resolve => socket.onopen = resolve);
      socket.send(JSON.stringify({ type: 'hello', seq: state.seq, generation: state.generation, scope: { tables: [] } }));
      const acks = [];
      try {
        for (const terminalId of ids) for (const command of ['terminal.attach', 'terminal.close']) {
          const cmd_id = `perf-cleanup-${crypto.randomUUID()}`;
          acks.push(await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Terminal cleanup timeout')), 15000);
            socket.addEventListener('message', function listen(event) {
              const data = JSON.parse(event.data);
              if (data.type === 'ack' && data.cmd_id === cmd_id) { clearTimeout(timer); socket.removeEventListener('message', listen); resolve(data); }
            });
            socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload: { terminalId } }));
          }));
        }
      } finally { socket.close(); }
      return acks;
    }, [...terminals]);
    if (acks.some(a => !a.ok)) throw new Error('Terminal cleanup failed');
  }
  try {
    if (!smoke || process.env.AGENT_GRAPH_PERF_SEND === '0') dashboard.send = { unavailable: 'Saved smoke conversation unavailable or send disabled' };
    else {
      await page.goto(`${BASE}/p/${encodeURIComponent(smoke.project)}?root=${encodeURIComponent(smoke.conversationId)}`); await lastVisible();
      const native = JSON.parse(smoke.conversationId)[1];
      let transcript;
      for (const directory of await readdir(join(homedir(), '.claude/projects'))) {
        const path = join(homedir(), '.claude/projects', directory, `${native}.jsonl`);
        if (await stat(path).then(() => true, () => false)) { transcript = path; break; }
      }
      if (!transcript) throw new Error('Smoke transcript missing');
      const offset = (await stat(transcript)).size;
      const marker = `perf-${Date.now()}`; const reply = `OK-${marker}`;
      const composer = active().locator('footer.composer');
      await composer.getByRole('textbox', { name: 'Message', exact: true }).fill(`速さの確認 ${marker}。${reply} とだけ返してください。`);
      await page.evaluate(({ marker, reply }) => {
        const m = window.__perf; m.sentAt = undefined; m.replyAt = undefined;
        const observer = new MutationObserver(() => {
          const root = document.querySelector('.workbench-body:not([hidden])');
          const articles = [...root?.querySelectorAll('article.message') ?? []];
          if (!m.sentAt && articles.some(a => a.dataset.side === 'end' && a.textContent.includes(marker))) m.sentAt = Date.now();
          if (!m.replyAt && articles.some(a => a.dataset.side !== 'end' && a.textContent.includes(reply))) m.replyAt = Date.now();
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      }, { marker, reply });
      const sentAt = Date.now(); await composer.getByRole('button', { name: 'Send', exact: true }).click();
      const poll = async () => {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          const tail = (await readFile(transcript)).subarray(offset).toString('utf8');
          if (tail.split('\n').filter(Boolean).some(line => { try { const row = JSON.parse(line); return row.type === 'assistant' && JSON.stringify(row.message?.content).includes(reply); } catch { return false; } })) return Date.now();
          await delay(100);
        }
        throw new Error('JSONL reply timeout');
      };
      const jsonlAt = await poll();
      await page.waitForFunction(() => window.__perf.replyAt, undefined, { timeout: 90000 });
      const stamps = await page.evaluate(() => ({ sentAt: window.__perf.sentAt, replyAt: window.__perf.replyAt }));
      dashboard.send = { n: 1, pollMs: 100, sentBubbleMs: stamps.sentAt - sentAt, replyJsonlToDomMs: stamps.replyAt - jsonlAt, note: 'Negative means the stream appeared before the persisted reply was detected' };
    }
  } catch (error) { dashboard.send = { unavailable: error.message }; }
  finally { await cleanup(); }
  return dashboard;
});
if (browser) await browser.close();
console.log(JSON.stringify(result));
