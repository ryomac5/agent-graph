import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { openLedger } from '../../../core/src/ledger/ledger.ts';
import { openObservationService } from '../service/index.ts';
import { startStaticServer } from '../static/index.ts';
import { startWebSocketServer } from '../ws/index.ts';

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>;

// 通信だけを置き換え、配信と上流の実際の HTTP ハンドラーを通す。
test('static search delivery authenticates, preserves filters and catches up new messages and diffs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ag-search-delivery-'));
  const service = openObservationService({ dbPath: join(directory, 'ledger.db'), home: directory, env: {} });
  const writer = openLedger(service.dbPath, { storageScope: 'full_diff' });
  const handlers = new Map<number, Handler>();
  let nextPort = 12000;
  t.mock.method(http, 'createServer', (handler: Handler) => {
    const port = ++nextPort;
    handlers.set(port, handler);
    return Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, done: () => void) => done(),
      address: () => ({ port }),
      close: (done: () => void) => done(),
    });
  });
  async function dispatch(url: URL, headers: Record<string, string> = {}, method = 'GET', remoteAddress = '127.0.0.1') {
    let body = '';
    let statusCode = 200;
    const responseHeaders: Record<string, string> = {};
    const output = Object.assign(new Writable({ write(chunk, _encoding, done) { body += chunk.toString(); done(); } }), {
      setHeader: (key: string, value: string) => { responseHeaders[key.toLowerCase()] = value; },
      writeHead: (status: number, values: Record<string, string> = {}) => {
        statusCode = status;
        for (const [key, value] of Object.entries(values)) responseHeaders[key.toLowerCase()] = value;
        return output;
      },
    });
    const finished = once(output, 'finish');
    await handlers.get(Number(url.port))!({ method, url: url.pathname + url.search,
      headers: { host: url.host, ...headers }, socket: { remoteAddress } } as http.IncomingMessage,
    output as unknown as http.ServerResponse);
    await finished;
    return { statusCode, headers: responseHeaders, body };
  }
  const forwarded: string[] = [];
  t.mock.method(http, 'request', (url: URL, options: { headers: Record<string, string> }, callback: (response: http.IncomingMessage) => void) => {
    const proxy = Object.assign(new EventEmitter(), {
      end() {
        forwarded.push(url.pathname + url.search);
        void dispatch(url, options.headers).then(result => {
          const input = Object.assign(new PassThrough(), { statusCode: result.statusCode });
          callback(input as unknown as http.IncomingMessage);
          input.end(result.body);
        }).catch(error => proxy.emit('error', error));
      },
      destroy() {},
    });
    return proxy;
  });
  syncBuiltinESMExports();
  let upstream: Awaited<ReturnType<typeof startWebSocketServer>> | undefined;
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await upstream?.close();
    writer.close();
    service.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(directory, { recursive: true, force: true });
  });
  upstream = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'absent.sock') });
  server = await startStaticServer({ port: 0, dist: directory, upstream });
  writer.append({ source: 'ui', source_event_id: 'message:m', kind: 'message.created', subject: 'message:m',
    payload: { provider: 'codex', native_id: 'm', role: 'assistant', version: 1, body_state: 'stored', body: 'DELIVERYNEEDLE message' },
    confidence: 'confirmed', source_ts: '2026-01-01T00:00:00Z' });
  writer.append({ source: 'ui', source_event_id: 'artifact:a', kind: 'artifact.version_created', subject: 'artifact:a',
    payload: { run_id: 'r', version: 1, repository_id: 'repo', worktree_id: 'w', base_sha: 'base', head_sha: 'head',
      patch_hash: 'hash', untracked: [], diff: '+DELIVERYNEEDLE fixed answer' },
    confidence: 'confirmed', source_ts: '2026-01-01T00:00:00Z' });
  const headers = { 'x-agent-graph-token': upstream.token, origin: server.url };
  const searchUrl = new URL('/api/search?q=DELIVERYNEEDLE&limit=10&offset=0', server.url);
  const result = await dispatch(searchUrl, headers);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(result.body).results.map((row: { kind: string }) => row.kind).sort(), ['diff', 'message']);
  assert.equal(forwarded.at(-1), searchUrl.pathname + searchUrl.search);
  const filtered = await dispatch(new URL(searchUrl.href + '&kind=diff'), headers);
  assert.equal(JSON.parse(filtered.body).total, 1);
  assert.equal(JSON.parse(filtered.body).results[0].body, '+DELIVERYNEEDLE fixed answer');
  assert.equal((await dispatch(new URL('/api/search?kind=invalid', server.url), headers)).statusCode, 400);
  const before = forwarded.length;
  for (const invalid of [
    { ...headers, 'x-agent-graph-token': '' },
    { ...headers, 'x-agent-graph-token': 'wrong' },
    { ...headers, host: 'evil.example' },
    { ...headers, origin: 'https://evil.example' },
  ]) assert.equal((await dispatch(searchUrl, invalid)).statusCode, 403);
  assert.equal((await dispatch(searchUrl, headers, 'GET', '192.0.2.1')).statusCode, 403);
  assert.equal(forwarded.length, before, 'rejected requests never reach upstream');
  assert.equal((await dispatch(new URL('/api/search', upstream.url))).statusCode, 403);
  assert.equal((await dispatch(new URL('/api/search', upstream.url), { 'x-agent-graph-token': upstream.token }, 'POST')).statusCode, 405);
});
