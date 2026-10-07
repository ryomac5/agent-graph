import assert from 'node:assert/strict';
import { execFileSync, fork, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const PLAYWRIGHT = process.env.AGENT_GRAPH_PLAYWRIGHT ?? '/Users/r/.npm/_npx/d71ea5ed3eabc9b3/node_modules/playwright/index.mjs';
const TIMEOUT_MS = 15_000;
const TITLE = 'Review fixture task';
const MARKER = 'REVIEWNEEDLE';
const FINDING = 'Replace the incorrect answer with the fixed answer.';

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
      const { defaultPolicy } = await import('../packages/core/src/assign/policy.ts');
      const { randomUUID } = await import('node:crypto');
      const ledger = openLedger(options.db, { storageScope: 'full_diff' });
      let counter = 0;
      function fact(kind, subject, payload) {
        const last = ledger.readSince(0, 10_000).at(-1);
        return { kind, subject, payload, confidence: 'confirmed', source_event_id: 'review-' + ++counter,
          source_ts: new Date(Math.max(Date.now(), Date.parse(last?.source_ts ?? 0) + 1)).toISOString() };
      }
      function append(kind, subject, payload) { ledger.append({ ...fact(kind, subject, payload), source: 'ui' }); }
      function reply(host, request, text) {
        const id = randomUUID();
        host.emit(request.runId, { type: 'fact', fact: fact('message.created', 'message:' + id, {
          provider: host.provider, native_id: id, version: 1, role: 'assistant', phase: 'final_answer', body_state: 'stored', body: text }) });
        host.emit(request.runId, { type: 'fact', fact: fact('message_membership.created', 'message_membership:' + id, {
          message_id: id, conversation_id: request.conversationId, active: true }) });
        host.emit(request.runId, { type: 'exit', exitCode: 0 });
      }
      // 再開しても元のホストの会話 ID を維持する。
      class ImplementationHost extends FakeHost {
        async resume(request) { return { ...await this.start(request), nativeId: request.nativeId }; }
      }
      class ReviewerHost extends FakeHost {
        async start(request) {
          const handle = await super.start(request);
          reply(this, request, JSON.stringify({ verdict: 'approve', comment: 'Fixture reviewed' }));
          return handle;
        }
      }
      const host = new ImplementationHost('codex');
      const reviewer = new ReviewerHost('claude');
      const policy = defaultPolicy();
      policy.roles.implement = [{ executor: 'codex', model: 'fake', family: 'openai', tier: 'high' }];
      policy.roles.review = [{ executor: 'claude', model: 'fake', family: 'anthropic', tier: 'high' }];
      const runner = await serveRunner(ledger, options.socket, { hosts: [host, reviewer], isolation: 'shared',
        reviewBlobDirectory: join(options.directory, 'agent-graph', 'blobs'),
        decision: { policy, quota: () => undefined, performance: () => undefined } });
      close = async () => { try { await runner.close(); } finally { ledger.close(); } };
      append('task.created', 'task:review-task', { name: TITLE, project: options.repo });
      append('task.created', 'task:origin-task', { name: 'Terminal origin', project: options.repo });
      append('conversation.created', 'conversation:origin', { provider: 'claude', native_id: 'review-origin', name: 'Terminal origin',
        task_id: 'origin-task', origin: 'observed', type: 'interactive', history_format: 'jsonl' });
      handle = async request => {
        if (request.action === 'submit') return runner.intake.command({ type: 'req', cmd_id: 'review-delegation', command: 'intake.submit', payload: {
          requestId: 'review-delegation', source: 'ui', role: 'implement', title: TITLE, task: 'Change code.txt and report ' + MARKER,
          cwd: options.repo, origin: { provider: 'claude', nativeId: 'review-origin' }, scope: ['code.txt'],
          accept: [`node -e "require('node:fs').appendFileSync('../acceptance.log', 'verified\\n')"`, 'test -f code.txt'] } });
        if (request.action === 'inspect') return { starts: host.starts, inputs: host.inputs,
          delegations: runner.intake.list() };
        if (request.action === 'complete' || request.action === 'fix') {
          const launch = host.starts.at(-1);
          assert.ok(launch, 'implementation started');
          if (request.action === 'fix') assert.ok(launch.input.text.includes(FINDING), 'finding delivered to original host');
          append('conversation.updated', 'conversation:' + launch.conversationId, { task_id: 'review-task', name: 'Implementation conversation' });
          await writeFile(join(launch.cwd, 'code.txt'), 'context before\n' + MARKER + (request.action === 'fix' ? ' fixed answer' : ' incorrect answer') + '\ncontext after\n');
          reply(host, launch, MARKER + (request.action === 'fix' ? ' correction completed' : ' implementation completed'));
          return { runId: launch.runId, conversationId: launch.conversationId };
        }
        throw new Error('Unknown fixture action');
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
  } finally {
    try { await close?.(); } finally { if (process.connected) process.disconnect(); }
  }
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-graph-review-'));
  console.log(`Review test artifacts: ${directory}`);
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
      env: { ...process.env, XDG_STATE_HOME: settings.directory },
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
    await run('git', ['-C', options.repo, 'config', 'user.name', 'Review test']);
    await run('git', ['-C', options.repo, 'config', 'user.email', 'review@example.invalid']);
    await writeFile(join(options.repo, 'code.txt'), 'context before\noriginal answer\ncontext after\n');
    await run('git', ['-C', options.repo, 'add', 'code.txt']);
    await run('git', ['-C', options.repo, 'commit', '-m', 'Review fixture']);
    await run(process.execPath, [join(ROOT, 'packages/dashboard/node_modules/vite/bin/vite.js'), 'build',
      '--configLoader', 'native', '--outDir', options.dist], join(ROOT, 'packages/dashboard'));
    const runner = await launch('runner', options);
    const api = await launch('api', options);
    const { chromium } = await import(PLAYWRIGHT);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    async function snapshot() {
      const response = await fetch(api.url + '/snapshot', { headers: { 'x-agent-graph-token': api.token } });
      assert.equal(response.status, 200); return response.json();
    }
    async function open(route) {
      const response = await page.goto(api.url + route);
      assert.equal(response.status(), 200, 'deep link ' + route);
      await page.locator('.connection.connected').waitFor();
    }
    async function screenshots(name) {
      for (const scheme of ['light', 'dark']) for (const width of [1440, 1024]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('html').getAttribute('data-theme'), scheme);
        const path = join(directory, name + '-' + scheme + '-' + width + '.png');
        await page.screenshot({ path, fullPage: true }); console.log('Screenshot: ' + path);
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    const prefix = '/p/' + encodeURIComponent(options.repo);
    await runner.request({ action: 'submit' });
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).starts.length === 1, 'delegation starts');
    const implementation = await runner.request({ action: 'complete' });
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).delegations.some(d => d.state === 'done'), 'delegation completes verification and review');
    let state = await snapshot();
    const original = state.projection.artifacts.find(a => a.run_id === implementation.runId);
    assert.ok(original?.patch_hash && original.base_sha && original.head_sha && original.worktree_id && original.repository_id, 'fixed artifact evidence');
    assert.ok(original.diff.includes(MARKER), 'fixed diff retained');
    assert.equal(original.version, 1);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: options.repo, encoding: 'utf8' }).trim(), 'M code.txt');
    await open('/');
    const reviewerName = 'Review of ' + TITLE;
    await page.getByRole('region', { name: options.repo, exact: true }).getByRole('article', { name: reviewerName, exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'No project', exact: true }).getByRole('article', { name: reviewerName, exact: true }).count(), 0, 'reviewer is not an independent No project task');
    assert.equal(await page.getByRole('article', { name: reviewerName, exact: true }).evaluate(row => row.previousElementSibling?.getAttribute('aria-label')), TITLE, 'reviewer appears directly beneath the original task');
    await screenshots('overview');
    await page.getByRole('navigation', { name: 'Projects', exact: true }).getByRole('link').click();
    await page.getByRole('heading', { name: 'repo', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Tasks', exact: true }).getByRole('article').filter({ hasText: MARKER + ' implementation completed' }).getByRole('button', { name: TITLE, exact: true }).click();
    await screenshots('workspace');
    await page.getByRole('link', { name: 'Open Changes', exact: true }).click();
    await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Comment on code.txt new line 2', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await waitUntil(async () => (await snapshot()).projection.approvals.some(a => a.artifact_id === original.id && a.state === 'approved'), 'approval stored');
    const approved = (await snapshot()).projection.approvals.find(a => a.artifact_id === original.id && a.state === 'approved');
    await page.getByRole('button', { name: 'Comment on code.txt new line 2', exact: true }).click();
    await page.getByRole('textbox', { name: 'Finding', exact: true }).fill(FINDING);
    await page.getByRole('button', { name: 'Add finding', exact: true }).click();
    await page.getByText(FINDING, { exact: true }).waitFor();
    await screenshots('changes-original');
    await page.getByRole('checkbox', { name: /Select finding/ }).check();
    await page.getByRole('button', { name: 'Return selected to agent', exact: true }).click();
    await waitUntil(async () => (await runner.request({ action: 'inspect' })).starts.length === 2, 'original conversation resumed');
    await waitUntil(async () => (await snapshot()).projection.findings.some(f => f.state === 'sent'), 'finding marked sent');
    const correction = await runner.request({ action: 'fix' });
    assert.equal(correction.conversationId, implementation.conversationId, 'same original conversation');
    await waitUntil(async () => (await snapshot()).projection.artifacts.some(a => a.previous_artifact_id === original.id && (typeof a.verification === 'string' ? JSON.parse(a.verification) : a.verification)?.passed), 'successor automatically reverified');
    state = await snapshot();
    const successor = state.projection.artifacts.find(a => a.previous_artifact_id === original.id);
    assert.equal(successor.version, 2, 'correction advances the artifact version');
    assert.notEqual(successor.patch_hash, original.patch_hash);
    assert.ok(successor.diff.includes('fixed answer'));
    assert.equal(state.projection.approvals.find(a => a.id === approved.id).state, 'stale');
    assert.ok(state.projection.findings.some(f => f.artifact_id === successor.id && ['fixed', 'needs_check'].includes(f.state)));
    const { readFile } = await import('node:fs/promises');
    assert.equal((await readFile(join(directory, 'acceptance.log'), 'utf8')).trim().split('\n').length, 2, 'acceptance reran on correction');
    await page.getByLabel('Version', { exact: true }).selectOption(successor.id);
    assert.match(await page.getByLabel('Version', { exact: true }).locator('option:checked').textContent(), /^Version 2(?: ·|$)/, 'corrected version is displayed as Version 2');
    await page.getByText('Stale · Invalid approval', { exact: true }).waitFor();
    await page.getByRole('region', { name: 'Acceptance verification' }).getByText('Passed', { exact: true }).waitFor();
    await screenshots('changes-corrected');
    await page.getByRole('navigation', { name: 'Project', exact: true }).getByRole('link', { name: 'Tree', exact: true }).click();
    const tree = page.getByRole('region', { name: 'Delegation tree', exact: true });
    await tree.getByRole('button', { name: 'Terminal origin', exact: true }).waitFor();
    await tree.getByRole('button', { name: TITLE, exact: true }).waitFor();
    assert.equal(await tree.getByRole('button', { name: TITLE, exact: true }).count(), 1, 'one implementation delegation node');
    assert.equal(await tree.locator(':scope > ul > li').count(), 1, 'one origin root');
    const implementationNode = tree.getByRole('button', { name: TITLE, exact: true }).locator('xpath=ancestor::li[1]');
    await implementationNode.locator(':scope > ul > li > .delegation-tree-card')
      .getByRole('button', { name: reviewerName, exact: true }).waitFor();
    const originNode = tree.getByRole('button', { name: 'Terminal origin', exact: true }).locator('xpath=ancestor::li[1]');
    assert.equal(await originNode.locator(':scope > ul > li').count(), 1, 'one delegation beneath origin');
    await tree.getByRole('button', { name: TITLE, exact: true }).click();
    const detail = page.getByRole('region', { name: 'Selected node', exact: true });
    await detail.locator('.delegation-actions').getByRole('link', { name: 'Open conversation', exact: true }).waitFor();
    await detail.getByText('Attempt history', { exact: true }).click();
    const attempts = detail.locator('.delegation-attempts li');
    assert.equal(await attempts.count(), 2, 'two execution attempts in the same delegation');
    assert.match(await attempts.nth(0).textContent(), /^Attempt 1 ·/);
    assert.match(await attempts.nth(1).textContent(), /^Attempt 2 ·/);
    assert.equal(new URL(await attempts.nth(0).getByRole('link', { name: 'Changes', exact: true }).getAttribute('href'), 'http://localhost').searchParams.get('run'), state.identities?.runs[implementation.runId] ?? implementation.runId, 'first attempt links to original run');
    assert.equal(new URL(await attempts.nth(1).getByRole('link', { name: 'Changes', exact: true }).getAttribute('href'), 'http://localhost').searchParams.get('run'), state.identities?.runs[correction.runId] ?? correction.runId, 'second attempt links to resumed run');
    const graph = page.getByLabel('Delegation graph', { exact: true });
    await graph.getByText('Terminal origin', { exact: true }).waitFor();
    await graph.getByText(TITLE, { exact: true }).waitFor();
    assert.equal(await graph.getByText(TITLE, { exact: true }).count(), 1, 'one implementation node in the graph');
    await screenshots('tree');
    await detail.locator('.delegation-actions').getByRole('link', { name: 'Open conversation', exact: true }).click();
    await page.getByText(MARKER + ' correction completed', { exact: true }).waitFor();
    await screenshots('conversation');
    await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Search', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search all conversations', exact: true }).fill(MARKER);
    const searchResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/search');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    assert.equal((await searchResponse).status(), 200, 'same-origin search API delivered');
    await page.getByRole('region', { name: 'Messages', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Diffs', exact: true }).waitFor();
    assert.ok((await page.getByRole('region', { name: 'Messages', exact: true }).textContent()).includes(MARKER), 'message search hit');
    assert.ok((await page.getByRole('region', { name: 'Diffs', exact: true }).textContent()).includes('fixed answer'), 'saved diff search hit');
    await screenshots('search');
    await open('/inbox');
    await page.getByRole('heading', { name: 'Approval inbox', exact: true }).waitFor();
    await screenshots('inbox');
    await open(prefix + '/tree');
    await page.getByRole('heading', { name: 'Delegation tree and graph' }).waitFor();
    await open(prefix + '/changes');
    await page.getByRole('heading', { name: 'Changes', exact: true }).waitFor();
    const rebuilt = await api.request();
    assert.deepEqual(normalize((await snapshot()).projection), normalize(rebuilt.projection), 'stage 6 projection matches rebuild');
    assert.deepEqual(errors, [], 'no browser exceptions');
    console.log('PASS: artifact, line finding, correction, revalidation, stale approval, origin tree and cross-search');
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
      console.log('Process log: ' + join(directory, 'process.log'));
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      if (failed) process.exitCode = 1;
    }
  }
}

if (process.env.AGENT_GRAPH_E2E !== '1') console.log('SKIP: set AGENT_GRAPH_E2E=1 to run the isolated browser review test.');
else if (process.argv[2] === '--worker') await worker(process.argv[3], JSON.parse(process.argv[4]));
else await main();
