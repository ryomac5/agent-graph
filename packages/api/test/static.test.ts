import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
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
  writeFileSync(join(dist, 'index.html'), '<html><head><meta name="agent-graph-token" content="__AGENT_GRAPH_TOKEN__"></head><body><div id="root"></div></body></html>');
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
  for (const path of ['/', '/p/demo', '/c/demo', '/inbox', '/p/demo/tree', '/p/demo/changes', '/p/demo/files', '/p/demo/graph', '/search', '/settings']) {
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
  // 会話の発言と一覧の続きも、同じ検証で api へ中継する。
  for (const path of ['/conversation?id=demo', '/projection?table=conversations']) {
    assert.equal((await fetch(server.url + path)).status, 403);
    const proxied = await fetch(server.url + path, { headers });
    const direct = await fetch(upstream.url + path, { headers });
    assert.equal(proxied.status, direct.status);
    assert.deepEqual(await proxied.text(), await direct.text());
  }
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
  writeFileSync(join(directory, 'index.html'), readFileSync(new URL('../../dashboard/app/index.html', import.meta.url)));
  const favicon = readFileSync(new URL('../../dashboard/app/public/favicon.svg', import.meta.url), 'utf8');
  writeFileSync(join(directory, 'favicon.svg'), favicon);
  writeFileSync(join(directory, 'app.css'), 'body{}');
  let handle!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  const server = Object.assign(new EventEmitter(), {
    listen: (_: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 12345 }), close: (done: () => void) => done(),
  });
  t.mock.method(http, 'createServer', (handler: typeof handle) => { handle = handler; return server as unknown as http.Server; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(directory, { recursive: true, force: true }); });
  let conversions = 0;
  let svgAttempts = 0;
  const endpoint = await startStaticServer({ port: 0, dist: directory,
    brand: { cacheHome: directory, sources: { chatgpt: join(directory, 'app.css'), claude: join(directory, 'absent.icns') },
      convert: async (_source, destination) => { conversions++; writeFileSync(destination, 'brand-png'); },
      fetchIcon: async () => { throw new Error('offline'); },
      fetchSvg: async url => { if (url.includes('orca')) { svgAttempts++; if (svgAttempts === 1) return 'invalid'; throw new Error('offline'); } return '<svg viewBox="0 0 24 24" onload="bad()"><script>bad()</script><path d="M0 0Z" onclick="bad()" href="https://bad"/></svg>'; } },
    upstream: { url: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:1/ws', token: 'injected-token', runner: { available: false } } });
  t.after(() => endpoint.close());
  async function get(url: string, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
    let status = 0; let body = ''; let bytes = Buffer.alloc(0);
    const responseHeaders: Record<string, string> = {};
    const response = Object.assign(new EventEmitter(), {
      setHeader: (key: string, value: string) => { responseHeaders[key] = value; },
      writeHead: (code: number, values: Record<string, string> = {}) => { status = code; Object.assign(responseHeaders, values); return response; },
      end: (value?: Buffer | string) => { bytes = Buffer.from(value ?? ''); body = bytes.toString(); },
    });
    await handle({ method: 'GET', url, headers: { host: '127.0.0.1:12345', ...headers },
      socket: { remoteAddress } } as http.IncomingMessage, response as unknown as http.ServerResponse);
    return { status, body, bytes, headers: responseHeaders };
  }
  const logo = await get('/brand/claude.svg');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers['Content-Type'], 'image/svg+xml');
  assert.equal(logo.headers['Content-Security-Policy'], "default-src 'none'");
  assert.match(logo.body, /#D97757/); assert.doesNotMatch(logo.body, /script|onload|onclick|https:\/\/bad/);
  assert.equal((await get('/brand/openai.svg')).status, 404);
  assert.equal((await get('/brand/openai.svg')).status, 404);
  assert.equal(svgAttempts, 2);
  const brand = await get('/brand/chatgpt.png');
  assert.equal(brand.status, 200); assert.equal(brand.body, 'brand-png');
  assert.equal(brand.headers['Content-Type'], 'image/png'); assert.equal(brand.headers['Cache-Control'], 'public, max-age=86400');
  assert.equal((await get('/brand/chatgpt.png')).status, 200); assert.equal(conversions, 1);
  assert.equal((await get('/brand/claude.png')).status, 404);
  assert.equal((await get('/brand/antigravity.png')).status, 404);
  assert.equal((await get('/brand/unknown.png')).status, 404);
  assert.equal((await get('/brand/chatgpt.png', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/brand/chatgpt.png', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/brand/chatgpt.png', {}, '192.168.0.2')).status, 403);
  const route = await get('/p/demo/tree');
  assert.equal(route.status, 200); assert.match(route.body, /injected-token/);
  assert.equal(route.headers['Cache-Control'], 'no-store');
  assert.match(route.headers['Content-Security-Policy'], /frame-ancestors/);
  assert.match(route.body, /<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg">/);
  const icon = await get('/favicon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['Content-Type'], 'image/svg+xml');
  assert.equal(icon.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(icon.body, favicon);
  assert.match(route.headers['Content-Security-Policy'], /(?:^|; )img-src 'self' data:;/);
  const nonces = new Set<string>();
  for (const response of [route, await get('/'), await get('/index.html')]) {
    assert.match(response.body, /<link rel="icon" type="image\/svg\+xml" href="\/favicon.svg">/);
    const nonce = response.body.match(/<meta name="agent-graph-style-nonce" content="([^"]+)">/)?.[1];
    assert.ok(nonce);
    assert.equal(Buffer.from(nonce, 'base64').length, 32);
    assert.equal(response.headers['Content-Security-Policy'], `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 3);
  assert.equal((await get('/app.css')).headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal((await get('/missing.js')).status, 404);
  mkdirSync(join(directory, '.vite'));
  writeFileSync(join(directory, '.vite/manifest.json'), '{"entry":"assets/app.js"}');
  writeFileSync(join(directory, '.vite/bundle-analysis.json'), '{"id":"/private/source.ts"}');
  for (const path of ['/.vite', '/.vite/', '/.vite/manifest.json', '/.vite/bundle-analysis.json', '/%2evite/manifest.json', '/.vite%2fbundle-analysis.json']) {
    const response = await get(path);
    assert.equal(response.status, 404);
    assert.equal(response.body, '');
  }
  assert.equal((await get('/%2e%2e%2fsecret')).status, 403);
  assert.equal((await get('/', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('/', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/snapshot')).status, 403);

  // 実際の圧縮ファイルを使い、ソケット制限下でも配信の見出しを検証する。
  mkdirSync(join(directory, 'assets'));
  const source = 'console.log("compressed asset")';
  const asset = join(directory, 'assets/app-abcdefgh.js');
  writeFileSync(asset, source);
  writeFileSync(asset + '.br', brotliCompressSync(source));
  writeFileSync(asset + '.gz', gzipSync(source));
  for (const [accept, encoding] of [
    ['gzip, br', 'br'], ['gzip', 'gzip'], ['br;q=0, gzip;q=1', 'gzip'],
    ['br;q=0.2, gzip;q=0.8', 'gzip'], ['*', 'br'], ['BR', 'br'],
    ['br;q=0, gzip;q=0', undefined], ['', undefined], ['deflate', undefined],
  ] as const) {
    const response = await get('/assets/app-abcdefgh.js', { 'accept-encoding': accept });
    assert.equal(response.status, 200);
    assert.equal(response.headers['Content-Encoding'], encoding);
    assert.equal(response.headers['Vary'], 'Accept-Encoding');
    assert.equal(response.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.equal(response.headers['Cache-Control'], 'public, max-age=31536000, immutable');
    assert.equal(Number(response.headers['Content-Length']), response.bytes.length);
    const decoded = encoding === 'br' ? brotliDecompressSync(response.bytes) : encoding === 'gzip' ? gunzipSync(response.bytes) : response.bytes;
    assert.equal(decoded.toString(), source);
  }
  assert.equal((await get('/app.css', { 'accept-encoding': 'br, gzip' })).body, 'body{}');
  assert.equal((await get('/app.css')).headers['Cache-Control'], 'no-store');
  writeFileSync(join(directory, 'app.css.gz'), gzipSync('body{}'));
  const css = await get('/app.css', { 'accept-encoding': 'br, gzip' });
  assert.equal(css.headers['Content-Encoding'], 'gzip');
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.equal(gunzipSync(css.bytes).toString(), 'body{}');
  writeFileSync(join(directory, 'assets/plain.js'), source);
  assert.equal((await get('/assets/plain.js')).headers['Cache-Control'], 'no-store');
  assert.equal((await get('/assets/missing-abcdefgh.js')).status, 404);
  assert.equal((await get('/app.css', { 'accept-encoding': 'identity;q=0, *;q=0' })).status, 406);
  const html = await get('/', { 'accept-encoding': 'br, gzip' });
  assert.equal(html.headers['Content-Encoding'], undefined);
  assert.equal(html.headers['Cache-Control'], 'no-store');
  assert.match(html.body, /injected-token/);
  writeFileSync(join(directory, 'index.html'), '<html><head></head><body>new build __AGENT_GRAPH_TOKEN__</body></html>');
  assert.match((await get('/')).body, /new build injected-token/);
  const updated = 'console.log("new build")';
  writeFileSync(asset, updated);
  utimesSync(asset + '.br', 0, 0); utimesSync(asset + '.gz', 0, 0);
  const stale = await get('/assets/app-abcdefgh.js', { 'accept-encoding': 'br, gzip' });
  assert.equal(stale.headers['Content-Encoding'], undefined); assert.equal(stale.body, updated);
  writeFileSync(asset + '.gz', gzipSync(updated));
  const rebuilt = await get('/assets/app-abcdefgh.js', { 'accept-encoding': 'br, gzip' });
  assert.equal(rebuilt.headers['Content-Encoding'], 'gzip'); assert.equal(gunzipSync(rebuilt.bytes).toString(), updated);
  const outside = mkdtempSync(join(tmpdir(), 'ag-static-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'private.br'), brotliCompressSync('private'));
  symlinkSync(join(outside, 'private.br'), join(directory, 'app.css.br'));
  assert.equal((await get('/app.css', { 'accept-encoding': 'br' })).body, 'body{}');
});
