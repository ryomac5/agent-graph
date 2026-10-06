import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const TOKEN_HEADER = "x-agent-graph-token";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);
export function readRequestUrl(request: IncomingMessage): URL | undefined {
  try { return new URL(request.url ?? "/", "http://localhost"); }
  catch { return undefined; }
}
export function createToken(): string { return randomBytes(32).toString("base64url"); }

// 旧 daemon と同じ Host・Origin・定時間のトークン検査を使う。
export function authorize(request: IncomingMessage, port: number, token: string): boolean {
  const host = request.headers.host;
  if (!host || !new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(host)
    || !LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "")) return false;
  if (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) return false;
  // ブラウザの WebSocket は任意のヘッダーを付けられない。
  const sent = request.headers[TOKEN_HEADER] ?? readRequestUrl(request)?.searchParams.get("token");
  if (typeof sent !== "string" || sent.length === 0) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(sent);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
