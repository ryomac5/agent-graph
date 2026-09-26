import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { TOKEN_HEADER, TOKEN_META_NAME } from "./contract.ts";
import type { RouteAuth } from "./route.ts";

export const TOKEN_FILE = "dashboard.token";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);

// DNS リバインディング対策。ループバック名にポートを付けた Host だけ受ける。
export function allowedHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function hostAllowed(request: IncomingMessage, port: number): boolean {
  const host = request.headers.host;
  return host !== undefined && allowedHosts(port).has(host);
}

export function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function tokenMatches(request: IncomingMessage, token: string): boolean {
  const sent = request.headers[TOKEN_HEADER];
  if (typeof sent !== "string" || sent.length === 0) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST の守り。通れば undefined、拒むなら理由を返す。
export function rejectPost(request: IncomingMessage, auth: RouteAuth, token: string): string | undefined {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return "Content-Type must be application/json";
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host ?? ""}`) return "Origin does not match";
  if (auth === "loopback") return isLoopback(request) ? undefined : "Local requests only";
  return tokenMatches(request, token) ? undefined : "Dashboard token is missing or invalid";
}

// 起動ごとに作り直す。読めるのは本人だけ。
export async function createToken(path: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: "w" });
  await chmod(path, 0o600);
  return token;
}

export function tokenMeta(token: string): string {
  return `<meta name="${TOKEN_META_NAME}" content="${token}">`;
}

// index.html の head にトークンの meta を埋め込む。
export function injectToken(html: string, token: string): string {
  const meta = tokenMeta(token);
  const head = html.search(/<head[^>]*>/i);
  if (head < 0) return `${meta}\n${html}`;
  const end = html.indexOf(">", head) + 1;
  return `${html.slice(0, end)}\n  ${meta}${html.slice(end)}`;
}
