import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { sendJson, WEBSOCKET_COMPRESSION } from '../../packages/api/src/ws/compression.ts';
import { createMemoryNetwork, readFrames } from '../../packages/api/test/fixtures/memory-http.ts';
import { REPEATS, summarize } from './baseline.mjs';

const { WebSocket, WebSocketServer } = createRequire(new URL('../../packages/api/package.json', import.meta.url))('ws');

export async function measureTransport(payloads) {
  const network = createMemoryNetwork(mock);
  let payload;
  let compressed = false;
  const server = http.createServer((request, response) => {
    if (compressed) sendJson(request, response, payload);
    else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  server.listen(0, () => {});
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = { mode: 'Real HTTP/ws framing over in-memory duplex streams; no TCP, TLS or production endpoint', repeats: REPEATS, http: {}, websocket: {} };
  try {
    for (const [name, value] of Object.entries(payloads)) {
      payload = value;
      const json = JSON.stringify(value);
      const measurements = {};
      for (const encoding of ['beforeIdentity', 'identity', 'br', 'gzip']) {
        compressed = encoding !== 'beforeIdentity';
        const times = [], cpu = [];
        let bytes, contentEncoding;
        for (let i = 0; i < REPEATS; i++) {
          const start = performance.now(), usage = process.cpuUsage();
          const response = await new Promise((resolve, reject) => {
            http.request(url, { headers: { 'accept-encoding': encoding === 'beforeIdentity' ? 'br, gzip' : encoding } }, async response => {
              try {
                const chunks = [];
                for await (const chunk of response) chunks.push(chunk);
                resolve({ headers: response.headers, body: Buffer.concat(chunks) });
              } catch (error) { reject(error); }
            }).on('error', reject).end();
          });
          times.push(performance.now() - start);
          const elapsed = process.cpuUsage(usage); cpu.push((elapsed.user + elapsed.system) / 1000);
          bytes = response.body.length;
          contentEncoding = response.headers['content-encoding'] ?? 'identity';
          const restored = contentEncoding === 'br' ? brotliDecompressSync(response.body) : contentEncoding === 'gzip' ? gunzipSync(response.body) : response.body;
          assert.equal(restored.toString(), json);
          network.connections.length = 0;
        }
        measurements[encoding] = { bytes, contentEncoding, elapsedMs: summarize(times), cpuMs: summarize(cpu) };
      }
      result.http[name] = measurements;
    }
    // 現行 WS で送る大きな投影 patch と小さな patch を、実際の ws で交渉・復元する。
    for (const [name, value] of Object.entries(payloads).filter(([name]) => name.endsWith('Patch'))) {
      result.websocket[name] = {};
      for (const enabled of [false, true]) {
        const wss = new WebSocketServer({ noServer: true, perMessageDeflate: enabled ? WEBSOCKET_COMPRESSION : false });
        const upgrade = (request, socket, head) => wss.handleUpgrade(request, socket, head, socket => wss.emit('connection', socket));
        server.on('upgrade', upgrade);
        wss.on('connection', socket => socket.on('message', () => socket.send(JSON.stringify(value))));
        const socket = new WebSocket(url.replace('http:', 'ws:'));
        try {
          await once(socket, 'open');
          const connection = network.connections.at(-1);
          const times = [], cpu = [];
          for (let i = 0; i < REPEATS; i++) {
            const start = performance.now(), usage = process.cpuUsage();
            const pending = once(socket, 'message');
            socket.send('next');
            const [message] = await pending;
            times.push(performance.now() - start);
            const elapsed = process.cpuUsage(usage); cpu.push((elapsed.user + elapsed.system) / 1000);
            assert.ok(message.toString() === JSON.stringify(value), 'WebSocket payload mismatch');
          }
          const frames = readFrames(connection.chunks);
          result.websocket[name][enabled ? 'deflate' : 'identity'] = { bytes: frames.at(-1).bytes,
            compressed: frames.at(-1).compressed, negotiated: socket.extensions,
            elapsedMs: summarize(times), cpuMs: summarize(cpu) };
        } finally { socket.terminate(); for (const client of wss.clients) client.terminate(); wss.close(); server.off('upgrade', upgrade); }
      }
    }
  } finally { network.close(); }
  return result;
}
