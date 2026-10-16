import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readActors, readJson, writeJson, waitFor, TIMEOUT_MS, START_TIMEOUT_MS, WATCH_TIMEOUT_MS } from './isolation.mjs';
import { DAY_MS, REPLY_PREFIX, COMPACT_SUMMARY } from './fixtures.mjs';

export async function scriptActor(control, pid, action, values = {}) {
  const name = `${randomUUID()}.json`;
  const path = join(control, String(pid), 'requests', name);
  await writeJson(path + '.tmp', { action, ...values }); await rename(path + '.tmp', path);
  const response = await waitFor(() => readJson(join(control, String(pid), 'responses', name)), `fake CLI: ${action}`);
  assert.equal(response.ok, true); return response.value;
}

export async function runJourneys({ browser, isolation, url, report, signal }) {
  const origin = new URL(url).origin;
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  assert.ok(!['7420', '7422'].includes(new URL(origin).port));
  const html = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text();
  const token = /<meta name="agent-graph-token" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(token, 'Dashboard token missing');
  const api = async path => {
    assert.ok(path.startsWith('/') && !path.startsWith('//'));
    const response = await fetch(origin + path, { headers: { 'x-agent-graph-token': token }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json();
  };
  const snapshot = () => api('/snapshot');
  const conversation = id => api(`/conversation?id=${encodeURIComponent(id)}`);
  const watches = id => api(`/api/send-watches?conversation=${encodeURIComponent(id)}`);
  const browserErrors = [], frames = [];
  let project, current = 'setup', page, context, sessions = [];
  const active = () => page.locator('.workbench-body:not([hidden])').filter({ has: page.locator('footer.composer') }).first();
  const composer = () => active().locator('footer.composer');
  // 本文の完全一致で探す。部分一致だと、同じ印で始まる後続の発言にも当たる。
  const exact = text => new RegExp('^\\s*' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
  const body = text => page.locator('.message-bubble .markdown-body', { hasText: exact(text) });
  const bubble = text => active().locator('article.message[data-side="end"]').filter({ has: body(text) });
  const agentMessage = text => active().locator('article.message:not([data-side="end"])').filter({ has: body(REPLY_PREFIX + text) });
  const actorState = session => readJson(join(isolation.control, String(session.pid), 'state.json'));
  const script = (session, action, values) => scriptActor(isolation.control, session.pid, action, values);
  const guard = () => { if (signal.aborted) throw signal.reason; };
  async function makePage() {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin === origin || ['data:', 'blob:'].includes(target.protocol)) return route.continue();
      browserErrors.push({ step: current, type: 'external-request', text: target.origin }); return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => {
      const target = new URL(socket.url());
      if (target.protocol === 'ws:' && target.host === new URL(origin).host) { socket.connectToServer(); return; }
      browserErrors.push({ step: current, type: 'external-websocket', text: target.origin });
      socket.close({ code: 1008, reason: 'Outside isolated dashboard' });
    });
    page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS); page.setDefaultNavigationTimeout(START_TIMEOUT_MS);
    page.on('pageerror', error => browserErrors.push({ step: current, type: 'pageerror', text: error.message }));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push({ step: current, type: 'console.error', text: message.text() }); });
    page.on('websocket', ws => {
      // メッセージを変更せず、送信と ack を証拠として採取する。
      for (const direction of ['framesent', 'framereceived']) ws.on(direction, frame => {
        let value; try { value = JSON.parse(String(frame.payload)); } catch { return; }
        if (['cmd', 'ack'].includes(value.type)) frames.push({ step: current, direction, value });
      });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Add project', exact: true }).waitFor();
    return page;
  }
  async function commands(list) {
    return page.evaluate(async commands => {
      const token = document.querySelector('meta[name="agent-graph-token"]').content;
      const state = await (await fetch('/snapshot', { headers: { 'x-agent-graph-token': token } })).json();
      const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
      const pending = new Map();
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'ack') pending.get(message.cmd_id)?.(message);
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('helper websocket timeout')), 10_000);
          socket.onopen = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error('helper websocket error')); };
        });
        socket.send(JSON.stringify({ type: 'hello', seq: state.seq, generation: state.generation, scope: { tables: [] } }));
        const results = [];
        for (const [command, payload] of commands) {
          const cmd_id = `e2e-read-${crypto.randomUUID()}`;
          results.push(await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(cmd_id); reject(new Error(`${command}: timeout`)); }, 10_000);
            pending.set(cmd_id, value => { clearTimeout(timer); pending.delete(cmd_id); resolve(value); });
            socket.send(JSON.stringify({ type: 'cmd', cmd_id, command, payload }));
          }));
        }
        return results;
      } finally { socket.close(); }
    }, list);
  }
  async function hosts() {
    const [ack] = await commands([['session.hosts', {}]]); assert.ok(ack.ok, ack.error); return ack.result.hosts;
  }
  async function createSession(provider = 'claude', options = {}) {
    guard();
    const before = new Set((await readActors(isolation.control)).map(actor => actor.pid));
    await writeJson(join(isolation.control, 'next-session.json'), options);
    // 利用者の provider 選択の保存値だけを設定する。起動と送信は画面操作。
    await page.evaluate(provider => localStorage.setItem('agent-graph-session-provider', provider), provider);
    // 開始ボタンは行に hover したときだけ見える。利用者と同じく行に乗せてから押す。
    const start = page.locator('.sidebar-project-row').filter({ has: page.locator('button[aria-label="Start conversation: journey-project"]') });
    await start.hover();
    await start.getByRole('button', { name: 'Start conversation: journey-project', exact: true }).click();
    const actor = await waitFor(async () => (await readActors(isolation.control)).find(actor => actor.provider === provider && actor.id && !before.has(actor.pid)), 'new fake CLI', START_TIMEOUT_MS);
    const session = { ...actor, original: JSON.stringify([provider, actor.id]) };
    sessions.push(session);
    const host = await waitFor(async () => (await hosts()).find(host => host.conversationId === session.original), 'host discovery', START_TIMEOUT_MS);
    session.terminalId = host.terminalId;
    await composer().getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    session.url = page.url();
    return session;
  }
  async function send(text) {
    guard(); await composer().getByRole('textbox', { name: 'Message', exact: true }).fill(text);
    await composer().getByRole('button', { name: 'Send', exact: true }).click();
  }
  async function reply(text) {
    await agentMessage(text).waitFor();
  }
  async function rootFor(id) {
    return waitFor(async () => (await snapshot()).projection.roots.find(root => root.conversation_ids?.includes(id) || root.id === id), `root for ${id}`);
  }
  const row = root => page.locator('.sidebar-roots').getByRole('link', { name: root.name, exact: true });
  async function openOriginal(session) {
    await page.goto(`${origin}/p/${encodeURIComponent(project)}?conversation=${encodeURIComponent(session.original)}`);
    await composer().getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  }
  async function seed(provider = 'claude', options) {
    const session = await createSession(provider, options);
    session.marker = `E2E ${current} ${randomUUID()}`;
    await send(session.marker); await reply(session.marker); return session;
  }
  async function assertWatch(id, text, state, timeout = TIMEOUT_MS) {
    return waitFor(async () => (await watches(id)).find(row => row.body === text && row.state === state), `send watch ${state}: ${text}`, timeout);
  }
  async function idle(session) {
    await waitFor(async () => !(await actorState(session)).working, 'fake completed');
    const root = await rootFor(session.original);
    await waitFor(async () => /\b(?:Idle|Done)\b/.test(await row(root).innerText()), 'Idle or Done');
    assert.equal(await active().getByRole('status', { name: 'Working', exact: true }).count(), 0);
  }
  async function terminal() {
    // 端末ボタンは本文ではなく、同じ pane の見出しの操作欄にある。
    await page.locator('section.workbench-pane').filter({ has: active() }).locator('header.workbench-tabs')
      .getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.locator('.workbench-body:not([hidden]) .xterm-helper-textarea').waitFor({ state: 'attached' });
  }
  async function terminalInput(text) {
    const input = page.locator('.workbench-body:not([hidden]) .xterm-helper-textarea');
    await input.focus(); await page.keyboard.type(text); await page.keyboard.press('Enter');
  }
  async function shot(name) { await page.screenshot({ path: join(report.directory, `${current}-${name}.png`), fullPage: true }); }
  async function closeSessions() {
    for (const session of sessions) {
      if (session.terminalId) {
        const acks = await commands([['terminal.attach', { terminalId: session.terminalId }], ['terminal.close', { terminalId: session.terminalId }]]);
        assert.ok(acks.every(ack => ack.ok), `Unable to close fixture terminal: ${JSON.stringify(acks)}`);
      } else { await script(session, 'exit'); }
    }
    sessions = [];
  }
  async function evidence() {
    return { snapshot: await snapshot(), actors: await readActors(isolation.control), frames: frames.filter(frame => frame.step === current), browserErrors: browserErrors.filter(error => error.step === current) };
  }
  const stopContext = () => { void context?.close(); };
  signal.addEventListener('abort', stopContext);
  // 調査用の絞り込み。未実行の項目は blocked になり、公開の判定は失敗のまま。
  const only = process.argv.find(value => value.startsWith('--only='))?.slice(7).split(',');
  async function check(id, run) {
    if (only && !only.includes(id)) return;
    guard(); current = id; await makePage();
    const result = await report.step(id, page, run, evidence);
    try { await closeSessions(); } catch (error) { report.errors.push(`項目 ${id} の端末片付け: ${error.message}`); }
    const trace = `${id}-trace.zip`;
    await context.tracing.stop({ path: join(report.directory, trace) }); result.artifacts.push(trace);
    await context.close(); await report.save();
  }
  try {
    await makePage();
    await page.getByRole('button', { name: 'Add project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add project', exact: true });
    // datalist 付きの input は combobox の role になる。
    await dialog.getByRole('combobox', { name: 'Location', exact: true }).fill(isolation.project);
    await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
    project = (await waitFor(async () => (await snapshot()).projection.projects.find(row => row.root_path === isolation.project), 'project registration')).id;
    await context.tracing.stop({ path: join(report.directory, 'setup-trace.zip') }); await context.close();

    for (const provider of ['claude', 'codex']) await check(`1-${provider}`, async () => {
      const session = await seed(provider);
      assert.equal(await bubble(session.marker).count(), 1);
      await assertWatch(session.original, session.marker, 'closed');
      return '新規起動から最初の送信と返事まで、画面と実履歴で確認';
    });
    await check('2', async () => {
      const session = await seed(); await script(session, 'hold-next');
      const first = session.marker + ' working', second = session.marker + ' queued';
      await send(first); await waitFor(async () => (await actorState(session)).working, 'working');
      await send(second);
      await bubble(second).getByRole('status').filter({ hasText: 'Queued' }).waitFor(); await shot('queued');
      await page.reload(); await bubble(second).getByRole('status').filter({ hasText: 'Queued' }).waitFor();
      await script(session, 'release'); await reply(second);
      await waitFor(async () => await bubble(second).count() === 1 && !(await bubble(second).innerText()).includes('Queued'), 'absorbed exactly once');
      await assertWatch(session.original, second, 'closed');
      await page.reload(); await reply(second); assert.equal(await bubble(second).count(), 1);
      const rows = (await readFile((await actorState(session)).path, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row => row.attachment?.type === 'queued_command' && row.attachment.prompt === second).length, 1);
    });
    await check('3', async () => {
      const session = await seed(); const latest = session.marker + ' latest';
      await send(latest); await reply(latest); await page.reload(); await reply(latest);
      const tabId = await page.getByRole('tab', { selected: true }).first().getAttribute('id');
      await terminal(); await page.locator(`[id=${JSON.stringify(tabId)}]`).click(); await reply(latest);
      await openOriginal(session); await reply(latest);
      // 圧縮の要約は通常の利用者発言として出さず、その後の最新発言は残す。
      await script(session, 'compact'); await send(session.marker + ' after compact'); await reply(session.marker + ' after compact');
      await page.reload(); await reply(session.marker + ' after compact');
      assert.equal(await active().locator('article.message').filter({ hasText: COMPACT_SUMMARY }).count(), 0);
    });
    await check('4', async () => {
      const session = await seed(); const before = await rootFor(session.original);
      const changed = await script(session, 'fork');
      const next = JSON.stringify(['claude', changed.id]);
      const root = await rootFor(next); assert.equal(root.id, before.id, 'fork moved to another root');
      // 分岐前から開いていたタブを維持したまま送る。
      const text = session.marker + ' after fork'; await send(text); await reply(text);
      assert.equal((await actorState(session)).id, changed.id);
      await openOriginal(session); await reply(text);
      await page.reload(); await reply(text); await reply(session.marker);
    });
    await check('5-ui', async () => {
      const session = await seed(); const root = await rootFor(session.original); const name = 'E2E row renamed';
      await row(root).dblclick();
      await page.getByRole('textbox', { name: 'Rename', exact: true }).fill(name);
      await page.getByRole('textbox', { name: 'Rename', exact: true }).press('Enter');
      await page.locator('.sidebar-roots').getByRole('link', { name, exact: true }).waitFor();
      await page.getByRole('tab', { name, exact: true }).waitFor();
      await page.reload(); await page.getByRole('tab', { name, exact: true }).waitFor();
    });
    await check('5-terminal', async () => {
      const session = await seed(); const name = 'E2E terminal renamed';
      await terminal(); await terminalInput('/rename ' + name);
      await page.locator('.sidebar-roots').getByRole('link', { name, exact: true }).waitFor();
      await page.getByRole('tab', { name, exact: true }).waitFor();
      await page.getByRole('tab', { name, exact: true }).click(); await reply(session.marker);
    });
    await check('6', async () => {
      const session = await seed();
      const conversationTab = await page.getByRole('tab', { selected: true }).first().getAttribute('id');
      await composer().getByRole('button', { name: /^Model ·/ }).click();
      await page.getByRole('menuitemradio').filter({ hasText: 'Haiku 5.5' }).click();
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await waitFor(async () => (await actorState(session)).panel, 'model confirmation panel');
      await page.locator('.workbench-body:not([hidden]) .xterm-helper-textarea').waitFor({ state: 'attached' }); await shot('confirmation');
      await page.locator(`[id=${JSON.stringify(conversationTab)}]`).click();
      const blocked = session.marker + ' must not reach CLI';
      await send(blocked);
      await composer().getByRole('alert').filter({ hasText: /terminal/i }).waitFor();
      assert.equal(await composer().getByRole('textbox', { name: 'Message', exact: true }).inputValue(), blocked);
      const audit = (await readFile(join(isolation.control, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(audit.filter(row => row.pid === session.pid && row.event === 'input' && row.text === blocked).length, 0);
      await shot('blocked-send');
      await terminal(); await page.locator('.workbench-body:not([hidden]) .xterm-helper-textarea').focus(); await page.keyboard.press('s');
      await waitFor(async () => { const state = await actorState(session); return !state.panel && state.model === 'haiku'; }, 'confirmed model');
      await page.locator(`[id=${JSON.stringify(conversationTab)}]`).click();
      await composer().getByRole('button', { name: /Model · Haiku/ }).waitFor();
      await send(session.marker + ' switched'); await reply(session.marker + ' switched');
    });
    await check('7', async () => {
      const session = await seed();
      for (const phase of ['first', 'after SessionEnd']) {
        if (phase !== 'first') await script(session, 'end');
        await script(session, 'hold-next'); await send(session.marker + ' ' + phase);
        await waitFor(async () => (await actorState(session)).working, 'fixture working');
        await active().getByRole('status', { name: 'Working', exact: true }).waitFor();
        const root = await rootFor(session.original);
        await waitFor(async () => /\bWorking\b/.test(await row(root).innerText()), 'sidebar Working');
        assert.ok(!(await row(root).innerText()).includes('Done')); await shot(phase === 'first' ? 'working' : 'resumed');
        await script(session, 'release'); await reply(session.marker + ' ' + phase); await idle(session);
      }
    });
    await check('8-date', async () => {
      const session = await seed('claude', { historyAgeMs: 2 * DAY_MS }); await idle(session);
      const rows = (await readFile((await actorState(session)).path, 'utf8')).trim().split('\n').map(JSON.parse);
      const latest = rows.filter(row => ['user', 'assistant'].includes(row.type)).at(-1).timestamp;
      const root = await rootFor(session.original);
      const time = row(root).locator('time.root-time'); await time.waitFor();
      // hook の確定時刻との差は許し、利用者が見る日付を比較する。
      assert.equal((await time.getAttribute('datetime'))?.slice(0, 10), latest.slice(0, 10), '行の日付が最新の発言日ではありません');
      await page.reload(); await row(root).locator('time.root-time').waitFor();
      assert.equal((await row(root).locator('time.root-time').getAttribute('datetime'))?.slice(0, 10), latest.slice(0, 10));
    });
    await check('8-root', async () => {
      const session = await seed(); const initial = await rootFor(session.original);
      const changed = await script(session, 'fork'); const next = JSON.stringify(['claude', changed.id]);
      await rootFor(next);
      const roots = (await snapshot()).projection.roots.filter(root => root.id === initial.id || root.conversation_ids.some(id => [session.original, next].includes(id)));
      assert.equal(roots.length, 1, '同じ継続系列が複数の根に分裂');
      assert.ok(roots[0].conversation_ids.includes(session.original) && roots[0].conversation_ids.includes(next));
      await waitFor(async () => await row(roots[0]).count() === 1, 'sidebar has exactly one row');
      // 再読み込み直後は一覧が空なので、行が描かれてから数える。
      await page.reload(); await row(roots[0]).first().waitFor(); assert.equal(await row(roots[0]).count(), 1);
    });
    await check('9-delivered', async () => {
      const session = await seed(); const watch = await assertWatch(session.original, session.marker, 'closed'); assert.ok(watch.message_id);
      // 製品の 60 秒の配達期限を越えても誤通知が出ない。
      await delay(61_000); guard();
      assert.equal((await watches(session.original)).find(row => row.body === session.marker).state, 'closed');
      assert.equal(await bubble(session.marker).getByRole('alert').count(), 0);
    });
    await check('9-missing', async () => {
      const session = await seed(); await idle(session); await script(session, 'drop-next');
      const text = session.marker + ' dropped'; await send(text);
      await assertWatch(session.original, text, 'failed', WATCH_TIMEOUT_MS);
      await bubble(text).getByRole('alert').filter({ hasText: 'Not delivered' }).waitFor();
      assert.equal(await agentMessage(text).count(), 0);
    });
    await check('9-bang', async () => {
      const session = await seed(); await idle(session);
      const delivered = '! echo E2E-delivered', missing = '! echo E2E-missing';
      await send(delivered);
      await waitFor(async () => (await readFile((await actorState(session)).path, 'utf8')).includes('<bash-input> echo E2E-delivered</bash-input>'), '! was received');
      await script(session, 'drop-next'); await send(missing);
      await assertWatch(session.original, missing, 'failed', WATCH_TIMEOUT_MS);
      await bubble(missing).getByRole('alert').filter({ hasText: 'Not delivered' }).waitFor();
      const deliveredWatch = (await watches(session.original)).find(row => row.body === delivered);
      assert.equal(deliveredWatch?.state, 'closed', '届いた ! 命令が未配達と扱われています');
      assert.equal(await bubble(delivered).getByRole('alert').count(), 0);
    });
    await check('10', async () => {
      assert.deepEqual(browserErrors, [], 'browser errors');
      return `${report.results.length} 項目の全 pageerror と console.error を確認`;
    });
  } finally {
    signal.removeEventListener('abort', stopContext);
    await writeJson(join(report.directory, 'browser-errors.json'), browserErrors);
    await writeJson(join(report.directory, 'commands.json'), frames);
    if (context) await context.close();
    const errorsResult = report.results.find(result => result.id === '10');
    if (errorsResult?.status === 'pass' && browserErrors.length) {
      errorsResult.status = 'fail'; errorsResult.error = JSON.stringify(browserErrors, null, 2); await report.save();
    }
  }
}
