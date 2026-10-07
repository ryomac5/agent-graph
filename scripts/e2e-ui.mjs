import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const PLAYWRIGHT = '/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const RUN = 'ui-run';
const CONVERSATION = 'ui-conversation';
const TITLE = 'Browser fixture task';
// Claude のホストと同じく、承認の ID は実行と要求の組から作る。
const approvalId = name => `${RUN}:${name}`;

async function waitUntil(check, label) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(50);
  }
}
function normalize(projection) {
  return Object.fromEntries(Object.entries(projection).map(([table, rows]) =>
    [table, [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))]));
}
async function worker(kind, options) {
  const { openLedger } = await import('../packages/core/src/ledger/ledger.ts');
  let close;
  let handle;
  try {
    if (kind === 'runner') {
      const { FakeHost } = await import('../packages/runner/src/host/contract.ts');
      const { serveRunner } = await import('../packages/runner/src/runtime.ts');
      const ledger = openLedger(options.db);
      const host = new FakeHost();
      const runner = await serveRunner(ledger, options.socket, { hosts: [host], isolation: 'shared' });
      close = async () => { await runner.close(); ledger.close(); };
      await runner.runtime.command({ type: 'req', cmd_id: 'fixture-start', command: 'start', payload: { runId: RUN, conversationId: CONVERSATION, provider: 'claude',
        cwd: options.repo, model: { model: 'fake', effort: 'high' }, input: { text: 'Test the UI' } } });
      let counter = 0;
      function fact(kind, subject, payload) {
        return { kind, subject, payload, confidence: 'confirmed', source_event_id: `ui-${++counter}`,
          source_ts: new Date(Date.now() + counter).toISOString() };
      }
      ledger.append({ ...fact('task.created', 'task:ui-task', { name: TITLE, project: options.repo }), source: 'ui' });
      ledger.append({ ...fact('conversation.updated', `conversation:${CONVERSATION}`, { task_id: 'ui-task', name: 'UI conversation' }), source: 'ui' });
      // 偽のホストは、Claude のホストと同じ形の事実を出す。hosts/claude/index.ts の assistant と承認の扱いに合わせる。
      const nativeId = host.starts[0].runId;
      handle = async request => {
        if (request.action === 'inspect') return { starts: host.starts.length, inputs: host.inputs, decisions: host.decisions,
          open: runner.runtime.supervisor.isOpen(RUN), seq: ledger.readSince(0, 10_000).at(-1)?.seq };
        if (request.action === 'state') host.emit(RUN, { type: 'state', state: request.state, reason: request.reason });
        else if (request.action === 'delta') host.emit(RUN, { type: 'delta', text: request.text, conversationId: CONVERSATION });
        else if (request.action === 'message') {
          const id = `${nativeId}:${request.id}`;
          host.emit(RUN, { type: 'fact', fact: fact('message.created', `message:${id}`, { provider: 'claude', native_id: request.id,
            version: 1, role: 'assistant', body: [{ type: 'text', text: request.text }, ...request.tools ?? []], body_state: 'stored' }) });
          host.emit(RUN, { type: 'fact', fact: fact('message_membership.created', `message_membership:${id}`, {
            message_id: id, conversation_id: CONVERSATION, active: true }) });
        } else if (request.action === 'approval') {
          const input = request.edit ? { file_path: join(options.repo, 'README.md'), old_string: 'Old line', new_string: `New line from ${request.id}` }
            : { command: `echo ${request.id}`, description: 'Print the fixture marker' };
          host.emit(RUN, { type: 'fact', fact: fact('approval.created', `approval:${approvalId(request.id)}`, {
            run_id: RUN, conversation_id: CONVERSATION, request_id: request.id, state: 'pending', available_decisions: ['allow', 'deny'],
            request: { name: request.edit ? 'Edit' : 'Bash', input, tool_use_id: `toolu_${request.id}` } }) });
        } else if (request.action === 'resolve') {
          const answer = host.decisions.findLast(row => row.approval === approvalId(request.id));
          if (answer) host.emit(RUN, { type: 'fact', fact: fact('approval.answered', `approval:${approvalId(request.id)}`, { decision: answer.decision }) });
          host.emit(RUN, { type: 'fact', fact: fact('approval.resolved', `approval:${approvalId(request.id)}`, { state: 'resolved' }) });
        }
        return true;
      };
      process.send({ ready: true });
    } else {
      const { openObservationService } = await import('../packages/api/src/service/index.ts');
      const { startWebSocketServer } = await import('../packages/api/src/ws/index.ts');
      const { startStaticServer } = await import('../packages/api/src/static/index.ts');
      const { ProjectionFeed } = await import('../packages/api/src/service/projection-feed.ts');
      const service = openObservationService({ dbPath: options.db, home: options.directory, env: {} });
      let api;
      let dashboard;
      close = async () => { await dashboard?.close(); await api?.close(); service.close(); };
      api = await startWebSocketServer(service, { port: 0, runnerPath: options.socket });
      dashboard = await startStaticServer({ port: options.port ?? 0, dist: options.dist, upstream: api });
      await waitUntil(() => api.runner.available, 'runner connection');
      handle = async () => {
        const feed = new ProjectionFeed(options.db, service.catchUp);
        try {
          const before = feed.snapshot();
          service.rebuild(); feed.refresh();
          const after = feed.snapshot();
          assert.deepEqual(normalize(before.projection), normalize(after.projection), 'projection equals ledger rebuild');
          return after;
        } finally { feed.close(); }
      };
      process.send({ ready: true, url: dashboard.url, token: api.token });
    }
    process.on('message', async message => {
      try { process.send({ rpcId: message.rpcId, result: await handle(message) }); }
      catch (error) { process.send({ rpcId: message.rpcId, error: error.stack }); }
    });
    await new Promise(resolve => {
      process.once('SIGTERM', resolve); process.once('SIGINT', resolve); process.once('disconnect', resolve);
    });
  } finally { await close?.(); }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-graph-ui-'));
  console.log(`UI test artifacts: ${directory}`);
  const options = { directory, db: join(directory, 'ledger.db'), socket: join(directory, 'runner.sock'),
    dist: join(directory, 'dist'), repo: join(directory, 'repo') };
  const children = new Set();
  const logs = [];
  let browser;
  let failed = false;
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); children.delete(child); }
  }
  function track(child) {
    children.add(child);
    child.stdout?.on('data', data => logs.push(data.toString()));
    child.stderr?.on('data', data => logs.push(data.toString()));
    return child;
  }
  async function run(command, args, cwd = ROOT) {
    const child = track(spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
    });
  }
  async function launch(kind, settings) {
    const child = track(fork(SCRIPT, ['--worker', kind, JSON.stringify(settings)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [],
    }));
    let ready;
    let failure;
    let nextId = 0;
    const pending = new Map();
    child.on('error', error => { failure = error; });
    child.on('exit', (code, signal) => {
      failure = new Error(`${kind} exited (${code ?? signal})`);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure); }
      pending.clear();
    });
    child.on('message', message => {
      if (message.ready) ready = message;
      const item = pending.get(message.rpcId);
      if (item) {
        pending.delete(message.rpcId); clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
      }
    });
    await waitUntil(() => { if (failure) throw failure; return ready; }, `${kind} startup`);
    return { child, ...ready, request(payload = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${kind} request timeout`)); }, TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer }); child.send({ ...payload, rpcId: id });
      });
    } };
  }
  const interrupted = () => { failed = true; void Promise.allSettled([...children].map(stop)).then(() => browser?.close()); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    await mkdir(options.repo);
    await run('git', ['init', '-b', 'main', options.repo]);
    await run('git', ['-C', options.repo, '-c', 'user.name=UI test', '-c', 'user.email=ui@example.invalid',
      'commit', '--allow-empty', '-m', 'UI fixture']);
    await run(process.execPath, [join(ROOT, 'packages/dashboard/node_modules/vite/bin/vite.js'), 'build',
      '--configLoader', 'native', '--outDir', options.dist], join(ROOT, 'packages/dashboard'));
    const runner = await launch('runner', options);
    let api = await launch('api', options);
    const port = Number(new URL(api.url).port);
    const { chromium } = await import(PLAYWRIGHT);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const snapshot = () => fetch(`${api.url}/snapshot`, { headers: { 'x-agent-graph-token': api.token } }).then(response => {
      assert.equal(response.status, 200); return response.json();
    });
    const initial = await snapshot();
    const conversation = initial.projection.conversations[0].id;
    const routes = { home: '/', workspace: `/p/${encodeURIComponent(options.repo)}`,
      conversation: `/c/${encodeURIComponent(conversation)}`, inbox: '/inbox' };
    const views = [];
    for (const [name, route] of Object.entries(routes)) {
      const page = await context.newPage();
      const view = { page, name, route, state: undefined };
      views.push(view);
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', async response => {
        if (new URL(response.url()).pathname === '/snapshot' && response.ok()) {
          const value = await response.json();
          if (!view.state || value.seq >= view.state.seq) view.state = value;
        }
      });
      page.on('websocket', ws => ws.on('framereceived', event => {
        const patch = JSON.parse(String(event.payload));
        if (patch.type !== 'patch' || !view.state || patch.seq <= view.state.seq) return;
        assert.ok(patch.from_seq <= view.state.seq, 'no missing browser patch');
        for (const [table, change] of Object.entries(patch.changes)) {
          const rows = new Map((view.state.projection[table] ?? []).map(row => [row.id, row]));
          for (const id of change.remove) rows.delete(id);
          for (const row of change.upsert) rows.set(row.id, row);
          view.state.projection[table] = [...rows.values()];
        }
        view.state.seq = patch.seq;
      }));
      const response = await page.goto(`${api.url}${route}`);
      assert.equal(response.status(), 200, `${name} deep link`);
      await page.locator('.connection.connected').waitFor();
      await page.getByRole('button', { name: 'Notifications', exact: true }).waitFor();
    }
    const [home, workspace, conversationView, inbox] = views.map(view => view.page);
    await waitUntil(() => views.every(view => view.state), 'initial browser snapshots');
    async function counts(count) {
      for (const view of views) await waitUntil(async () => await view.page.locator('.approval-count strong').textContent() === String(count), `${view.name} inbox count`);
    }
    async function text(page, value) { await page.getByText(value, { exact: true }).first().waitFor(); }
    // 各画面を明るい配色と暗い配色、幅 1440 と 1024 で撮る。最後に元の幅と配色へ戻す。
    async function screenshots(suffix) {
      for (const view of views) {
        for (const scheme of ['light', 'dark']) for (const width of [1440, 1024]) {
          await view.page.emulateMedia({ colorScheme: scheme });
          await view.page.setViewportSize({ width, height: 900 });
          // 配色の切り替えの遷移が終わってから撮る。
          await view.page.waitForTimeout(300);
          await view.page.screenshot({ path: join(directory, `${view.name}-${suffix}-${scheme}-${width}.png`), fullPage: true });
        }
        await view.page.emulateMedia({ colorScheme: 'light' });
        await view.page.setViewportSize({ width: 1440, height: 1000 });
      }
    }
    async function consistent() {
      const rebuilt = await api.request();
      await waitUntil(() => views.every(view => view.state?.seq === rebuilt.seq && view.state?.generation === rebuilt.generation), 'browser resync to ledger');
      for (const view of views) assert.deepEqual(normalize(view.state.projection), normalize(rebuilt.projection), `${view.name} projection matches ledger`);
      assert.deepEqual(errors, [], 'no browser exceptions');
    }
    await runner.request({ action: 'state', state: 'running' });
    await runner.request({ action: 'message', id: 'plan', text: 'I will inspect the repository first.\n\n- Read `README.md`\n- Run the **tests**',
      tools: [{ type: 'tool_use', id: 'toolu_plan', name: 'Bash', input: { command: 'git status --short', description: 'Show working tree status' } }] });
    await text(conversationView, 'I will inspect the repository first.');
    await runner.request({ action: 'delta', text: 'Live streaming reply' });
    await text(conversationView, 'Live streaming reply'); await text(workspace, 'Live streaming reply');
    await runner.request({ action: 'message', id: 'reply', text: 'Completed browser reply' });
    for (const page of [home, workspace, conversationView]) await text(page, 'Completed browser reply');
    await waitUntil(async () => await conversationView.getByText('Live streaming reply', { exact: true }).count() === 0, 'delta replaced by fact');
    await runner.request({ action: 'state', state: 'waiting_approval' });
    await runner.request({ action: 'approval', id: 'approval-one' });
    await counts(1);
    await text(inbox, 'echo approval-one');
    await inbox.getByRole('button', { name: 'Allow', exact: true }).click();
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).decisions.some(row => row.approval === approvalId('approval-one') && row.decision === 'allow'), 'inbox answer delivered to host');
    await runner.request({ action: 'resolve', id: 'approval-one' }); await counts(0);
    await runner.request({ action: 'approval', id: 'approval-two', edit: true }); await counts(1);
    await home.getByRole('button', { name: 'Notifications', exact: true }).click();
    const notifications = home.getByRole('region', { name: 'Notifications', exact: true });
    await notifications.getByRole('button', { name: 'Deny', exact: true }).waitFor();
    await home.screenshot({ path: join(directory, 'home-notifications-light-1440.png') });
    await notifications.getByRole('button', { name: 'Deny', exact: true }).click();
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).decisions.some(row => row.approval === approvalId('approval-two') && row.decision === 'deny'), 'notification answer delivered to host');
    await runner.request({ action: 'resolve', id: 'approval-two' }); await counts(0);
    await home.getByRole('button', { name: 'Notifications', exact: true }).click();
    await runner.request({ action: 'state', state: 'unknown', reason: 'Fixture observation interrupted' });
    for (const page of [home, workspace, conversationView]) {
      await page.getByRole('link', { name: 'Unknown · Evidence', exact: true }).first().waitFor();
      assert.ok(await page.locator('.state-badge.status-unknown').count());
    }
    await screenshots('unknown');
    await runner.request({ action: 'state', state: 'waiting_approval' });
    await runner.request({ action: 'approval', id: 'approval-restart' }); await counts(1);
    await text(inbox, 'echo approval-restart');
    await consistent(); await screenshots('live');
    await stop(api.child);
    for (const view of views) await view.page.locator('.connection.reconnecting').waitFor();
    const before = await runner.request({ action: 'inspect' });
    await runner.request({ action: 'message', id: 'downtime', text: 'Durable reply during API downtime' });
    await runner.request({ action: 'state', state: 'waiting_approval' });
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).seq > before.seq + 2, 'durable downtime events');
    const previousToken = api.token;
    api = await launch('api', { ...options, port });
    assert.notEqual(api.token, previousToken, 'API restart rotates credentials');
    for (const view of views) await view.page.locator('.connection.connected').waitFor();
    for (const page of [home, workspace, conversationView]) await text(page, 'Durable reply during API downtime');
    await consistent(); await counts(1);
    await text(inbox, 'echo approval-restart');
    await inbox.getByRole('button', { name: 'Deny', exact: true }).click();
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).decisions.some(row => row.approval === approvalId('approval-restart') && row.decision === 'deny'), 'pending approval survives restart');
    await runner.request({ action: 'resolve', id: 'approval-restart' }); await counts(0);
    await runner.request({ action: 'state', state: 'waiting_input' });
    const after = await runner.request({ action: 'inspect' });
    assert.equal(after.starts, 1); assert.equal(after.open, true);
    await conversationView.getByRole('textbox', { name: 'Message', exact: true }).fill('Browser input after restart');
    await conversationView.getByRole('button', { name: 'Send', exact: true }).click();
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).inputs.some(row => row.input.text === 'Browser input after restart'), 'input reaches existing host after restart');
    await screenshots('restarted');
    for (const view of views) {
      await view.page.reload(); await view.page.locator('.connection.connected').waitFor();
    }
    await consistent();
    assert.equal(failed, false, 'test interrupted');
    console.log(`PASS: four routes, live events, approval answers, reconnect and API restart. Screenshots: ${directory}`);
  } catch (error) {
    failed = true;
    console.error(error.stack);
    if (browser) for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      await page.screenshot({ path: join(directory, `failure-${index}.png`), fullPage: true }).catch(() => {});
    }
  } finally {
    try { await browser?.close(); }
    finally {
      await Promise.allSettled([...children].map(stop));
      await writeFile(join(directory, 'process.log'), logs.join(''));
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      if (failed) process.exitCode = 1;
    }
  }
}

if (process.env.AGENT_GRAPH_E2E !== '1') console.log('SKIP: set AGENT_GRAPH_E2E=1 to run the isolated browser UI test.');
else if (process.argv[2] === '--worker') await worker(process.argv[3], JSON.parse(process.argv[4]));
else await main();
