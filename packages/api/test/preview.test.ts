import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createFilesApi, handleFilesCommand } from '../src/files/index.ts';
import { MAX_PREVIEW_TICKETS, PREVIEW_TTL_MS } from '../src/files/preview.ts';
import { openObservationService } from '../src/service/index.ts';
import { PREVIEW_CSP, startStaticServer } from '../src/static/index.ts';

const execute = promisify(execFile);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'ag-preview-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  await mkdir(join(root, 'page space'), { recursive: true });
  await execute('git', ['-C', root, 'init']);
  await writeFile(join(root, 'page space', 'index #.HTML'), '<link rel="stylesheet" href="style.css"><script>window.preview = true</script>');
  await writeFile(join(root, 'page space', 'style.css'), 'body { color: red; }');
  await writeFile(join(root, '.gitignore'), 'hidden.html\n');
  await writeFile(join(root, 'hidden.html'), 'hidden');
  await writeFile(join(root, 'binary.html'), Buffer.from([0, 255]));
  await writeFile(join(directory, 'outside.html'), 'outside');
  await symlink(join(root, 'page space', 'index #.HTML'), join(root, 'link.html'));
  await symlink(join(root, 'page space'), join(root, 'linkdir'));
  await symlink(join(directory, 'outside.html'), join(root, 'escape.html'));
  const dbPath = join(directory, 'ledger.db');
  const service = openObservationService({ dbPath });
  t.after(() => service.close());
  service.ledger.append({ source: 'ui', source_event_id: 'preview-project', kind: 'project.created', subject: 'project:preview',
    source_ts: '2026-10-10T00:00:00Z', confidence: 'confirmed', payload: {
      repository_id: 'preview-project', root_path: root, display_name: 'Preview', name_prefix: 'Preview', state: 'registered',
    } });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => db.close());
  const api = createFilesApi(db);
  return { api, root, directory, request: { projectId: 'preview-project', path: 'page space/index #.HTML' } };
}

test('preview tickets bind a visible root, override only the entry and expire with a bounded store', async t => {
  const { api, request, root, directory } = await fixture(t);
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const result = await handleFilesCommand(api, 'files.preview', request) as Awaited<ReturnType<typeof api.preview>>;
  assert.equal(result.expiresAt, now + PREVIEW_TTL_MS);
  assert.match(result.url, /^\/preview\/[\w-]{43}\/page%20space\/index%20%23.HTML$/);
  const ticket = result.url.split('/')[2];
  assert.equal(Buffer.from(ticket, 'base64url').length, 32);
  assert.match((await api.readPreview(ticket, request.path))!.toString(), /window.preview/);
  assert.equal((await api.readPreview(ticket, 'page space/style.css'))!.toString(), 'body { color: red; }');
  const edited = await api.preview({ ...request, content: '' });
  assert.equal((await api.readPreview(edited.url.split('/')[2], request.path))!.length, 0);
  for (const path of ['../outside.html', join(directory, 'outside.html'), '.git/config', 'hidden.html', 'link.html', 'linkdir/index #.HTML', 'escape.html']) {
    assert.equal(await api.readPreview(ticket, path), undefined);
    await assert.rejects(handleFilesCommand(api, 'files.preview', { ...request, path, content: 'override' }), /invalid_path/);
  }
  for (const payload of [null, {}, { ...request, path: 1 }, { ...request, projectId: 'unknown' }, { ...request, worktree: directory }]) {
    await assert.rejects(handleFilesCommand(api, 'files.preview', payload), /invalid_path/);
  }
  for (const payload of [{ ...request, path: 'page space/style.css' }, { ...request, path: 'binary.html' }, { ...request, content: 1 }, { ...request, content: '\0' }]) {
    await assert.rejects(handleFilesCommand(api, 'files.preview', payload), /not_previewable/);
  }
  assert.equal(await api.readPreview('forged', request.path), undefined);
  clock.mock.mockImplementation(() => now + PREVIEW_TTL_MS);
  assert.equal(await api.readPreview(ticket, request.path), undefined);
  assert.equal(await api.readPreview(edited.url.split('/')[2], request.path), undefined);
  clock.mock.mockImplementation(() => now);
  const first = await api.preview(request);
  for (let index = 0; index < MAX_PREVIEW_TICKETS; index++) await api.preview(request);
  assert.equal(await api.readPreview(first.url.split('/')[2], request.path), undefined);
  const current = await api.preview(request);
  await rm(join(root, 'page space', 'index #.HTML'));
  await symlink(join(directory, 'outside.html'), join(root, 'page space', 'index #.HTML'));
  assert.equal(await api.readPreview(current.url.split('/')[2], request.path), undefined);
  api.clearPreviews();
});

test('static preview serves HTML and sibling assets without token, with isolation and 404 boundaries', async t => {
  const { api, request, directory } = await fixture(t);
  let handle!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  const server = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 12345 }), close: (done: () => void) => done(),
  });
  t.mock.method(http, 'createServer', (handler: typeof handle) => { handle = handler; return server as unknown as http.Server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const endpoint = await startStaticServer({ port: 0, dist: directory, upstream: {
    url: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'secret-dashboard-token',
    runner: { available: false }, previews: api,
  } });
  t.after(() => endpoint.close());
  async function get(url: string, headers: Record<string, string> = {}, address = '127.0.0.1', method = 'GET') {
    let status = 0; let body = '';
    const responseHeaders: Record<string, string> = {};
    const response = {
      setHeader: (key: string, value: string) => { responseHeaders[key] = value; },
      writeHead: (code: number, values: Record<string, string> = {}) => { status = code; Object.assign(responseHeaders, values); return response; },
      end: (value?: Buffer | string) => { body = value?.toString() ?? ''; },
    };
    await handle({ method, url, headers: { host: '127.0.0.1:12345', ...headers }, socket: { remoteAddress: address } } as http.IncomingMessage,
      response as unknown as http.ServerResponse);
    return { status, body, headers: responseHeaders };
  }
  const entry = await api.preview(request);
  const base = entry.url.slice(0, entry.url.lastIndexOf('/') + 1);
  const html = await get(entry.url);
  assert.equal(html.status, 200);
  assert.match(html.body, /window.preview/);
  assert.equal(html.headers['Content-Security-Policy'], PREVIEW_CSP);
  assert.equal(html.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(html.headers['Cache-Control'], 'no-store');
  assert.equal(html.headers['Content-Type'], 'text/html; charset=utf-8');
  const css = await get(base + 'style.css');
  assert.equal(css.status, 200);
  assert.equal(css.body, 'body { color: red; }');
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(css.headers['Content-Security-Policy'], PREVIEW_CSP);
  const edited = await api.preview({ ...request, content: '<head>__AGENT_GRAPH_TOKEN__</head><p>unsaved</p>' });
  assert.equal((await get(edited.url)).body, '<head>__AGENT_GRAPH_TOKEN__</head><p>unsaved</p>');
  const prefix = '/preview/' + entry.url.split('/')[2] + '/';
  for (const path of ['../outside.html', '../../index.html', '%2e%2e%2foutside.html', '.git/config', 'hidden.html', 'link.html', 'linkdir/index%20%23.HTML', 'escape.html', 'missing.html', '%ZZ']) {
    assert.equal((await get(prefix + path)).status, 404, path);
  }
  assert.equal((await get('/preview/' + 'a'.repeat(43) + '/page%20space/index%20%23.HTML')).status, 404);
  assert.equal((await get(entry.url, { host: 'evil.example' })).status, 403);
  assert.equal((await get(entry.url, {}, '192.0.2.1')).status, 403);
  assert.equal((await get(entry.url, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(entry.url, {}, '127.0.0.1', 'POST')).status, 404);
  t.mock.method(Date, 'now', () => entry.expiresAt);
  assert.equal((await get(entry.url)).status, 404);
});
