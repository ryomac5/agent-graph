import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import http, { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { openObservationService } from '../src/service/index.ts';
import { startWebSocketServer } from '../src/ws/index.ts';
import { startStaticServer } from '../src/static/index.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ag-static-'));
  const dist = join(directory, 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<meta name="agent-graph-token" content="__AGENT_GRAPH_TOKEN__"><div id="root"></div>');
  writeFileSync(join(dist, 'app.js'), 'console.log("app")');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = openObservationService({ dbPath: join(directory, 'db.sqlite') });
  t.after(() => service.close());
  const upstream = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'absent.sock') });
  t.after(() => upstream.close());
  const server = await startStaticServer({ port: 0, dist, upstream });
  t.after(() => server.close());
  return { server, upstream };
}
testSocket('static SPA routes embed token, serve assets and enforce same-origin access', async t => {
  const { server, upstream } = await fixture(t);
  for (const path of ['/', '/p/demo', '/c/demo', '/inbox', '/p/demo/tree', '/p/demo/changes', '/search', '/settings']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.ok((await response.text()).includes(upstream.token));
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(server.url + '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(server.url + '/missing.js')).status, 404);
  assert.equal((await fetch(server.url, { headers: { Origin: 'https://evil.example' } })).status, 403);
  // fetch は Host を上書きするため、実際の HTTP ヘッダーで拒否を確かめる。
  const badHost = await new Promise<number>((done, fail) => {
    const probe = request(server.url, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); done(response.statusCode!);
    });
    probe.on('error', fail);
    probe.end();
  });
  assert.equal(badHost, 403);
  const traversal = await new Promise<number>(done => {
    request(server.url + '/%2e%2e%2fsecret', response => { response.resume(); done(response.statusCode!); }).end();
  });
  assert.equal(traversal, 403);
});
testSocket('snapshot requires token and returns the exact API snapshot', async t => {
  const { server, upstream } = await fixture(t);
  assert.equal((await fetch(server.url + '/snapshot')).status, 403);
  const headers = { 'x-agent-graph-token': upstream.token };
  const response = await fetch(server.url + '/snapshot', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), await (await fetch(upstream.url + '/snapshot', { headers })).json());
});
testSocket('WebSocket proxies hello and commands, reports runner absence and rejects a bad origin', async t => {
  const { server, upstream } = await fixture(t);
  const url = server.url.replace('http:', 'ws:') + '/ws?token=' + upstream.token;
  const socket = new WebSocket(url, { origin: server.url });
  t.after(() => socket.terminate());
  const messages: Record<string, unknown>[] = [];
  const ack = new Promise<Record<string, unknown>>((done, fail) => {
    socket.on('error', fail);
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); messages.push(message);
      if (message.type === 'ack') done(message);
    });
  });
  await new Promise<void>(done => socket.once('open', done));
  socket.send(JSON.stringify({ type: 'hello', seq: 0, generation: 0 }));
  socket.send(JSON.stringify({ type: 'cmd', cmd_id: 'test', command: 'test' }));
  assert.deepEqual(await ack, { type: 'ack', cmd_id: 'test', ok: false, error: 'Runner unavailable' });
  assert.ok(messages.some(message => message.type === 'runner' && message.available === false));
  const rejected = new WebSocket(url, { origin: 'https://evil.example' });
  await new Promise<void>((done, fail) => {
    rejected.on('open', () => { rejected.terminate(); fail(new Error('Unexpected upgrade')); });
    rejected.on('unexpected-response', (_, response) => { assert.equal(response.statusCode, 403); response.resume(); rejected.terminate(); done(); });
    rejected.on('error', () => {});
  });
});

function testSocket(name: string, action: (t: TestContext) => Promise<void>) {
  test(name, { timeout: 5000 }, async t => {
    try { await action(t); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EPERM'
        && 'syscall' in error && error.syscall === 'listen')) throw error;
      t.skip('sandbox blocks local TCP socket listen');
    }
  });
}

test('static handler serves real files and applies security without a socket', async t => {
  const { EventEmitter } = await import('node:events');
  const { syncBuiltinESMExports } = await import('node:module');
  const directory = mkdtempSync(join(tmpdir(), 'ag-static-handler-'));
  writeFileSync(join(directory, 'index.html'), '<meta content="__AGENT_GRAPH_TOKEN__">');
  writeFileSync(join(directory, 'app.css'), 'body{}');
  let handle!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  const server = Object.assign(new EventEmitter(), {
    listen: (_: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 12345 }), close: (done: () => void) => done(),
  });
  t.mock.method(http, 'createServer', (handler: typeof handle) => { handle = handler; return server as unknown as http.Server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  const endpoint = await startStaticServer({ port: 0, dist: directory,
    upstream: { url: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'injected-token', runner: { available: false } } });
  t.after(() => endpoint.close());
  async function get(url: string, headers: Record<string, string> = {}) {
    let status = 0; let body = '';
    const responseHeaders: Record<string, string> = {};
    const response = Object.assign(new EventEmitter(), {
      setHeader: (key: string, value: string) => { responseHeaders[key] = value; },
      writeHead: (code: number, values: Record<string, string> = {}) => { status = code; Object.assign(responseHeaders, values); return response; },
      end: (value?: Buffer | string) => { body = value?.toString() ?? ''; },
    });
    await handle({ method: 'GET', url, headers: { host: '127.0.0.1:12345', ...headers },
      socket: { remoteAddress: '127.0.0.1' } } as http.IncomingMessage, response as unknown as http.ServerResponse);
    return { status, body, headers: responseHeaders };
  }
  const route = await get('/p/demo/tree');
  assert.equal(route.status, 200); assert.match(route.body, /injected-token/);
  assert.equal(route.headers['Cache-Control'], 'no-store');
  assert.match(route.headers['Content-Security-Policy'], /frame-ancestors/);
  assert.equal((await get('/app.css')).headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal((await get('/missing.js')).status, 404);
  assert.equal((await get('/%2e%2e%2fsecret')).status, 403);
  assert.equal((await get('/', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/snapshot')).status, 403);
});
