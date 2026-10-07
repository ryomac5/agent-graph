import { createServer, request as requestHttp } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { authorize, readRequestUrl } from '../ws/security.ts';

export const DEFAULT_DASHBOARD_PORT = 7422;
const DEFAULT_DIST = fileURLToPath(new URL('../../../dashboard/dist/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
interface StaticOptions {
  port?: number; dist?: string; upstream: { url: string; wsUrl: string; token: string; runner: { available: boolean } };
}
export async function startStaticServer(options: StaticOptions) {
  const { upstream } = options;
  const root = resolve(options.dist ?? DEFAULT_DIST);
  let port = options.port ?? DEFAULT_DASHBOARD_PORT;
  const origin = () => `http://127.0.0.1:${port}`;
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const host = request.headers.host;
    if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)
      || request.headers.origin !== undefined && request.headers.origin !== `http://${host}`
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      response.writeHead(403).end(); return;
    }
    const url = readRequestUrl(request);
    if (!url || request.method !== 'GET') { response.writeHead(404).end(); return; }
    if (url.pathname === '/snapshot' || url.pathname === '/api/search') {
      if (!authorize(request, port, upstream.token)) { response.writeHead(403).end(); return; }
      const proxy = requestHttp(new URL(url.pathname + url.search, upstream.url), {
        headers: { 'x-agent-graph-token': upstream.token },
      }, result => {
        response.writeHead(result.statusCode ?? 502, { 'Content-Type': 'application/json' });
        result.pipe(response);
      });
      proxy.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => { if (!response.writableEnded) proxy.destroy(); });
      proxy.end(); return;
    }
    try {
      const pathname = decodeURIComponent(url.pathname);
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      const isRoute = url.pathname === '/' || /^\/(?:p|c)\/[^/]+(?:\/(?:tree|changes))?$/.test(url.pathname)
        || ['/inbox', '/search', '/settings'].includes(url.pathname);
      if (isRoute) file = resolve(root, 'index.html');
      const actual = await realpath(file);
      const actualRoot = await realpath(root);
      if (!actual.startsWith(actualRoot + sep) || !(await stat(actual)).isFile()) { response.writeHead(403).end(); return; }
      let content: Buffer | string = await readFile(actual);
      if (extname(actual) === '.html') {
        content = content.toString().replaceAll('__AGENT_GRAPH_TOKEN__', upstream.token);
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      }
      response.writeHead(200, { 'Content-Type': MIME[extname(actual)] ?? 'application/octet-stream' });
      response.end(content);
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      response.writeHead(missing ? 404 : error instanceof URIError ? 400 : 500).end();
    }
  });
  server.on('upgrade', (request, socket, head) => {
    if (!authorize(request, port, upstream.token) || readRequestUrl(request)?.pathname !== '/ws') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, browser => {
      const url = new URL(upstream.wsUrl);
      url.searchParams.set('token', upstream.token);
      const remote = new WebSocket(url);
      sockets.add(browser); sockets.add(remote);
      // 中継の接続前に hello を受けても捨てない。
      const queue: { data: Buffer; binary: boolean }[] = [];
      let queuedBytes = 0;
      browser.on('message', (data, binary) => {
        const buffer = Buffer.from(data as Buffer);
        if (remote.readyState === WebSocket.OPEN) remote.send(buffer, { binary });
        else if (remote.readyState === WebSocket.CONNECTING) {
          queuedBytes += buffer.length;
          if (queuedBytes > 1024 * 1024) { browser.close(1009); return; }
          queue.push({ data: buffer, binary });
        }
      });
      remote.on('open', () => { for (const item of queue) remote.send(item.data, { binary: item.binary }); queue.length = 0; });
      remote.on('message', (data, binary) => {
        if (browser.readyState !== WebSocket.OPEN) return;
        if (browser.bufferedAmount > 4 * 1024 * 1024) { browser.terminate(); return; }
        browser.send(data, { binary });
      });
      let available: boolean | undefined;
      const report = () => {
        if (browser.readyState === WebSocket.OPEN && available !== upstream.runner.available) {
          available = upstream.runner.available;
          browser.send(JSON.stringify({ type: 'runner', available }));
        }
      };
      report();
      const timer = setInterval(report, 500);
      browser.on('error', () => browser.terminate());
      remote.on('error', () => { browser.close(1011); remote.terminate(); });
      browser.on('close', () => { clearInterval(timer); sockets.delete(browser); remote.terminate(); });
      remote.on('close', () => { sockets.delete(remote); browser.close(); });
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  port = (server.address() as { port: number }).port;
  return { url: origin(), close: async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(done => wss.close(() => done()));
    await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  } };
}
