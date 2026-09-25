import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import type { Repo, Store } from "../../../core/src/store/store.ts";
import { buildGraph, diffGraph } from "./graph.ts";

const KEEP_ALIVE_MS = 15_000;
const POLL_MS = 500;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png",
};

export interface HttpOptions {
  port: number;
  openStores: Map<string, Store>;
  listRepos: () => Repo[];
  staticDir?: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendEvent(response: ServerResponse, event: string, value: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function sendStatic(response: ServerResponse, staticDir: string, pathname: string): Promise<void> {
  const root = await realpath(staticDir);
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { response.writeHead(400).end(); return; }
  const path = resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    response.writeHead(403).end();
    return;
  }
  let actual: string;
  try { actual = await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { response.writeHead(404).end(); return; }
    throw error;
  }
  const actualRel = relative(root, actual);
  if (actualRel === ".." || actualRel.startsWith(`..${sep}`) || actualRel.startsWith(sep)) {
    response.writeHead(403).end();
    return;
  }
  if (!(await stat(actual)).isFile()) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": MIME[extname(actual)] ?? "application/octet-stream" });
  createReadStream(actual).pipe(response);
}

export async function startHttpServer(options: HttpOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (url.pathname === "/api/repos") {
        sendJson(response, 200, options.listRepos());
        return;
      }
      if (url.pathname === "/api/graph" || url.pathname === "/api/events") {
        const key = url.searchParams.get("repo");
        const store = key === null ? undefined : options.openStores.get(key);
        if (!store) { sendJson(response, 404, { error: "Repository not found" }); return; }
        if (url.pathname === "/api/graph") {
          sendJson(response, 200, buildGraph(store.db, { session: url.searchParams.get("session") ?? undefined }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache", connection: "keep-alive" });
        response.flushHeaders();
        const graph = () => buildGraph(store.db);
        let previous = graph();
        sendEvent(response, "snapshot", previous);
        const emit = (): void => {
          const next = graph();
          for (const change of diffGraph(previous, next)) sendEvent(response, "delegation", change);
          previous = next;
        };
        const unsubscribe = store.onChange(emit);
        const poll = setInterval(emit, POLL_MS);
        const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
        response.once("close", () => { unsubscribe(); clearInterval(poll); clearInterval(keepAlive); });
        return;
      }
      if (!options.staticDir) { response.writeHead(404).end(); return; }
      await sendStatic(response, options.staticDir, (request.url ?? "/").split("?", 1)[0]);
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}
