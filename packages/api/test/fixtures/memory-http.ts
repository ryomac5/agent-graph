import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { Duplex, PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';

// TCP の代わりにメモリ上の双方向ストリームを使い、HTTP と ws の実装はそのまま通す。
export function createMemoryNetwork(mock: TestContext['mock']) {
  const servers = new Map<number, http.Server>();
  const connections: { port: number; chunks: Buffer[] }[] = [];
  const sockets = new Set<Duplex>();
  const createServer = http.createServer;
  const request = http.request;
  const connect = net.connect;
  let nextPort = 19000;
  function open(port: number) {
    const server = servers.get(port);
    if (!server) throw new Error(`Unknown memory port: ${port}`);
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const client = Duplex.from({ readable: outgoing, writable: incoming });
    const remote = Duplex.from({ readable: incoming, writable: outgoing });
    const chunks: Buffer[] = [];
    connections.push({ port, chunks });
    outgoing.on('data', chunk => chunks.push(Buffer.from(chunk)));
    for (const socket of [client, remote]) {
      Object.assign(socket, { remoteAddress: '127.0.0.1', localPort: port,
        setTimeout: () => socket, setNoDelay: () => socket, setKeepAlive: () => socket });
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    }
    server.emit('connection', remote);
    return client;
  }
  mock.method(http, 'createServer', (...args: Parameters<typeof createServer>) => {
    const server = createServer(...args);
    const port = ++nextPort;
    servers.set(port, server);
    mock.method(server, 'listen', (...args: unknown[]) => { (args.at(-1) as () => void)(); return server; });
    mock.method(server, 'address', () => ({ port, address: '127.0.0.1', family: 'IPv4' }));
    mock.method(server, 'close', (done: () => void) => { servers.delete(port); done(); return server; });
    return server;
  });
  mock.method(http, 'request', (url: URL | string | http.RequestOptions, options?: http.RequestOptions | ((response: http.IncomingMessage) => void), done?: (response: http.IncomingMessage) => void) => {
    if (typeof url === 'object' && !(url instanceof URL)) return request(url, typeof options === 'function' ? options : done);
    return request(url, { ...(typeof options === 'object' ? options : {}), createConnection: () => open(Number(new URL(url).port)) },
      typeof options === 'function' ? options : done);
  });
  mock.method(net, 'connect', (options: net.NetConnectOpts) =>
    'port' in options && servers.has(Number(options.port)) ? open(Number(options.port)) : connect(options));
  syncBuiltinESMExports();
  return { connections, open, close() {
    for (const socket of sockets) socket.destroy();
    mock.restoreAll();
    syncBuiltinESMExports();
  } };
}

export function readFrames(chunks: Buffer[]) {
  const buffer = Buffer.concat(chunks);
  const boundary = buffer.indexOf('\r\n\r\n');
  if (boundary < 0) throw new Error('Missing HTTP upgrade');
  const frames: { compressed: boolean; opcode: number; bytes: number }[] = [];
  for (let offset = boundary + 4; offset < buffer.length;) {
    const start = offset;
    const first = buffer[offset++];
    const second = buffer[offset++];
    let length = second & 127;
    if (length === 126) { length = buffer.readUInt16BE(offset); offset += 2; }
    else if (length === 127) { length = Number(buffer.readBigUInt64BE(offset)); offset += 8; }
    if (second & 128) offset += 4;
    offset += length;
    if (offset > buffer.length) throw new Error('Incomplete WebSocket frame');
    frames.push({ compressed: Boolean(first & 64), opcode: first & 15, bytes: offset - start });
  }
  return frames;
}
