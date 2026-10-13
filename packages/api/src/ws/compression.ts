import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { PerMessageDeflateOptions } from 'ws';

export const COMPRESSION_MIN_BYTES = 4 * 1024;
export const GZIP_OPTIONS = { level: 1 };
export const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };
export const WEBSOCKET_COMPRESSION: PerMessageDeflateOptions = {
  threshold: COMPRESSION_MIN_BYTES,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 2,
  zlibDeflateOptions: GZIP_OPTIONS,
};

function selectEncoding(header = '') {
  const qualities = new Map(header.toLowerCase().split(',').map(item => {
    const [name, ...parameters] = item.trim().split(';');
    const parameter = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    const value = parameter?.slice(2);
    const quality = value === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    return [name.trim(), quality] as const;
  }));
  const identity = qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1);
  const candidates = (['br', 'gzip'] as const)
    .map(encoding => ({ encoding, quality: qualities.get(encoding) ?? qualities.get('*') ?? 0 }))
    .filter(item => item.quality > 0).sort((a, b) => b.quality - a.quality);
  const preferred = candidates[0];
  return { identity, encoding: preferred && (qualities.get('identity') ?? 0) <= preferred.quality ? preferred.encoding : undefined };
}

export function sendJson(request: IncomingMessage, response: ServerResponse, value: unknown, status = 200): void {
  const body = Buffer.from(JSON.stringify(value));
  const { encoding, identity } = selectEncoding(request.headers['accept-encoding']);
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Vary', 'Accept-Encoding');
  function finish(content: Buffer, coding?: string) {
    if (response.destroyed) return;
    if (coding) response.setHeader('Content-Encoding', coding);
    response.setHeader('Content-Length', content.length);
    response.writeHead(status);
    response.end(content);
  }
  if (!encoding) {
    if (identity > 0) finish(body);
    else response.writeHead(406).end();
    return;
  }
  // 小さい応答は即座に返す。identity を拒否した要求だけは圧縮する。
  if (body.length < COMPRESSION_MIN_BYTES && identity > 0) { finish(body); return; }
  const done = (error: Error | null, compressed: Buffer) => {
    if (response.destroyed) return;
    if (error) { response.writeHead(500).end(); return; }
    if (compressed.length >= body.length && identity > 0) finish(body);
    else finish(compressed, encoding);
  };
  // 非同期 zlib で、投影や小さな patch の配信を主スレッドで待たせない。
  if (encoding === 'br') brotliCompress(body, BROTLI_OPTIONS, done);
  else gzip(body, GZIP_OPTIONS, done);
}
