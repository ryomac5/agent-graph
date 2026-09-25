import type { IncomingMessage, ServerResponse } from "node:http";
import type { Repo, Store } from "../../../core/src/store/store.ts";

export interface HttpOptions {
  port: number;
  openStores: Map<string, Store>;
  listRepos: () => Repo[];
  staticDir?: string;
  // トークンの保存先。省略時は runDir()/dashboard.token
  tokenPath?: string;
}

// POST の認証方式。token はダッシュボードから、loopback は hook から。
export type RouteAuth = "token" | "loopback";

export interface RouteContext {
  options: HttpOptions;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  // path が RegExp のとき、捕捉した部分
  params: string[];
  readJson: (maxBytes?: number) => Promise<unknown>;
}

export interface Route {
  method: "GET" | "POST";
  path: string | RegExp;
  // POST のときだけ使う。既定は token
  auth?: RouteAuth;
  handle: (context: RouteContext) => Promise<void> | void;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export function sendEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

export function notImplemented(context: RouteContext): void {
  sendJson(context.response, 501, { error: `${context.request.method} ${context.url.pathname} is not implemented yet` });
}

export function matchRoute(route: Route, method: string | undefined, pathname: string): string[] | undefined {
  if (route.method !== method) return undefined;
  if (typeof route.path === "string") return route.path === pathname ? [] : undefined;
  const found = route.path.exec(pathname);
  return found ? found.slice(1) : undefined;
}
