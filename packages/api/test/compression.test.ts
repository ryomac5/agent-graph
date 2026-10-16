import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { COMPRESSION_MIN_BYTES, sendJson } from '../src/ws/compression.ts';
import { startWebSocketServer } from '../src/ws/index.ts';
import { startStaticServer } from '../src/static/index.ts';
import { openObservationService } from '../src/service/index.ts';
import { createCompactSnapshotFeed, LEGACY } from './fixtures/compact-snapshot.ts';
import { createMemoryNetwork, readFrames } from './fixtures/memory-http.ts';

async function readResponse(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    http.request(url, { headers }, async response => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(Buffer.from(chunk));
        resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) });
      } catch (error) { reject(error); }
    }).on('error', reject).end();
  });
}
function decode(response: Awaited<ReturnType<typeof readResponse>>) {
  return JSON.parse((response.headers['content-encoding'] === 'br' ? brotliDecompressSync(response.body)
    : response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body).toString());
}

test('JSON negotiates br/gzip/identity, counts UTF-8 bytes and skips small responses', async t => {
  const network = createMemoryNetwork(t.mock);
  t.after(() => network.close());
  let value: unknown = { body: '日本語 JSON '.repeat(1000) };
  const server = http.createServer((request, response) => sendJson(request, response, value));
  server.listen(0, () => {});
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [accept, encoding, status = 200] of [
    [undefined, undefined], ['', undefined], ['br, gzip', 'br'], ['GZIP', 'gzip'],
    ['br;q=0.4, gzip;q=0.8', 'gzip'], ['br;q=0, gzip', 'gzip'], ['*', 'br'],
    ['br;q=0, *;q=0.5', 'gzip'], ['br;q=broken, gzip', 'gzip'],
    ['br;q=2, gzip;q=0', undefined], ['deflate', undefined], ['identity', undefined],
    ['identity;q=1, br;q=0.5', undefined], ['identity;q=0, gzip', 'gzip'],
    ['*;q=0, identity;q=1', undefined], ['br;q=0, gzip;q=0, identity;q=0', undefined, 406],
    ['*;q=0', undefined, 406],
  ] as const) {
    const response = await readResponse(url, accept === undefined ? {} : { 'accept-encoding': accept });
    assert.equal(response.status, status, accept);
    assert.equal(response.headers['content-encoding'], encoding, accept);
    assert.equal(response.headers.vary, 'Accept-Encoding');
    if (status === 200) {
      assert.deepEqual(decode(response), value);
      assert.equal(Number(response.headers['content-length']), response.body.length);
      if (encoding) assert.ok(response.body.length < Buffer.byteLength(JSON.stringify(value)));
    }
  }
  for (const size of [COMPRESSION_MIN_BYTES - 1, COMPRESSION_MIN_BYTES]) {
    value = 'x'.repeat(size - 2);
    const response = await readResponse(url, { 'accept-encoding': 'br' });
    assert.equal(response.headers['content-encoding'], size < COMPRESSION_MIN_BYTES ? undefined : 'br');
    assert.deepEqual(decode(response), value);
  }
  value = { ok: true };
  assert.equal((await readResponse(url, { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined);
  const forced = await readResponse(url, { 'accept-encoding': 'gzip, identity;q=0' });
  assert.equal(forced.headers['content-encoding'], 'gzip');
  assert.deepEqual(decode(forced), value);
});

test('API and dashboard relay preserve compressed JSON and negotiate WS frames without compressing small patches', { timeout: 10000 }, async t => {
  const network = createMemoryNetwork(t.mock);
  const directory = mkdtempSync(join(tmpdir(), 'compression-'));
  const path = join(directory, 'ledger.db');
  const f = createCompactSnapshotFeed(path);
  const service = openObservationService({ dbPath: path, home: directory, env: {} });
  let api: Awaited<ReturnType<typeof startWebSocketServer>> | undefined;
  let relay: Awaited<ReturnType<typeof startStaticServer>> | undefined;
  t.after(async () => {
    await relay?.close(); await api?.close(); service.close(); f.close(); network.close();
    rmSync(directory, { recursive: true });
  });
  f.append('message.created', 'message:reply', { role: 'assistant', body: '圧縮 SEARCHNEEDLE '.repeat(2000), body_state: 'stored', version: 2 });
  api = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, 'absent.sock') });
  relay = await startStaticServer({ port: 0, dist: directory, upstream: api });
  const headers = { 'x-agent-graph-token': api.token };
  for (const path of ['/snapshot', `/conversation?id=${encodeURIComponent(LEGACY)}&latest=1`, '/projection?table=relations',
    '/api/search?q=SEARCHNEEDLE', `/api/send-watches?conversation=${encodeURIComponent(LEGACY)}`]) {
    const original = await readResponse(api.url + path, headers);
    assert.equal(original.status, 200);
    for (const encoding of ['br', 'gzip']) {
      const direct = await readResponse(api.url + path, { ...headers, 'accept-encoding': encoding });
      const proxied = await readResponse(relay.url + path, { ...headers, 'accept-encoding': encoding });
      assert.deepEqual(proxied.body, direct.body);
      for (const key of ['content-encoding', 'content-length', 'content-type', 'vary']) assert.equal(proxied.headers[key], direct.headers[key]);
      assert.deepEqual(decode(proxied), decode(original));
      assert.equal(proxied.headers['cache-control'], 'no-store');
      if (original.body.length >= COMPRESSION_MIN_BYTES) assert.equal(proxied.headers['content-encoding'], encoding);
    }
  }
  assert.equal((await readResponse(relay.url + '/snapshot')).status, 403);
  assert.equal((await readResponse(relay.url + '/snapshot', { ...headers, origin: 'https://invalid.example' })).status, 403);
  assert.equal((await readResponse(relay.url + '/snapshot', { ...headers, 'accept-encoding': '*;q=0' })).status, 406);
  const snapshot = api.feed.snapshot();
  f.append('relation.updated', 'relation:delegated', { evidence: { description: 'Large patch 日本語 '.repeat(1000) } });
  const patch = api.feed.refresh();
  assert.ok(patch && patch !== 'resync');
  f.append('run.state_changed', `run:${LEGACY}:1`, { state: 'idle' });
  const smallPatch = api.feed.refresh();
  assert.ok(smallPatch && smallPatch !== 'resync');
  for (const endpoint of [api.url, relay.url]) for (const enabled of [true, false]) {
    const socket: WebSocket = new WebSocket(endpoint.replace('http:', 'ws:') + `/ws?token=${api.token}`, { perMessageDeflate: enabled, origin: endpoint });
    const messages: Record<string, unknown>[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    assert.equal(socket.extensions, enabled ? 'permessage-deflate' : '');
    const connection = network.connections.findLast(connection => connection.port === Number(new URL(endpoint).port))!;
    socket.send(JSON.stringify({ type: 'hello', seq: snapshot.seq, generation: snapshot.generation }));
    while (!messages.some(message => message.type === 'send_watches')) await once(socket, 'message');
    const received = messages.find(message => message.type === 'patch')!;
    assert.deepEqual(received.changes, JSON.parse(JSON.stringify(patch.changes)));
    assert.deepEqual(messages.filter(message => message.type === 'patch').map(message => message.changes),
      JSON.parse(JSON.stringify([patch.changes, smallPatch.changes])));
    assert.ok(Buffer.byteLength(JSON.stringify(messages.filter(message => message.type === 'patch')[1])) < COMPRESSION_MIN_BYTES);
    socket.send(JSON.stringify({ type: 'cmd', cmd_id: 'small', command: 'start' }));
    while (!messages.some(message => message.type === 'ack')) await once(socket, 'message');
    const frames = readFrames(connection.chunks).filter(frame => frame.opcode === 1);
    assert.equal(frames.length, messages.length);
    frames.forEach((frame, index) => assert.equal(frame.compressed, enabled && Buffer.byteLength(JSON.stringify(messages[index])) >= COMPRESSION_MIN_BYTES));
    assert.ok(frames.find((_, index) => messages[index].type === 'patch')!.bytes < (enabled ? Buffer.byteLength(JSON.stringify(received)) : Infinity));
    socket.terminate();
  }
});
