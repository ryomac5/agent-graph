import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { runDir } from "../paths.ts";
import { HttpError, matchRoute, sendJson, type HttpOptions, type RouteContext } from "./route.ts";
import { routes } from "./routes/index.ts";
import { createToken, hostAllowed, injectToken, rejectPost, TOKEN_FILE } from "./security.ts";

export type { HttpOptions } from "./route.ts";

const DEFAULT_MAX_BODY_BYTES = 65_536;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png",
};

function readJson(request: IncomingMessage): (maxBytes?: number) => Promise<unknown> {
  let cached: Promise<unknown> | undefined;
  return (maxBytes = DEFAULT_MAX_BODY_BYTES) => cached ??= (async () => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    for await (const chunk of request) {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) throw new HttpError(400, "Request body too large");
      body += chunk;
    }
    try { return JSON.parse(body) as unknown; }
    catch (error) { throw new HttpError(400, `Invalid JSON body: ${(error as Error).message}`); }
  })();
}

async function sendStatic(response: ServerResponse, staticDir: string, pathname: string, token: string): Promise<void> {
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
  if (actualRel === "index.html") {
    // トークンはファイルに置かず、応答のたびに埋め込む。
    response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    response.end(injectToken(await readFile(actual, "utf8"), token));
    return;
  }
  response.writeHead(200, { "content-type": MIME[extname(actual)] ?? "application/octet-stream" });
  createReadStream(actual).pipe(response);
}

export async function startHttpServer(options: HttpOptions): Promise<Server> {
  const token = await createToken(options.tokenPath ?? join(runDir(), TOKEN_FILE));
  let port = options.port;
  const server = createServer((request, response) => {
    void (async () => {
      if (!hostAllowed(request, port)) { sendJson(response, 403, { error: "Host is not allowed" }); return; }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      for (const route of routes) {
        const params = matchRoute(route, request.method, url.pathname);
        if (!params) continue;
        if (route.method === "POST") {
          const reason = rejectPost(request, route.auth ?? "token", token);
          if (reason) { sendJson(response, 403, { error: reason }); return; }
        }
        const context: RouteContext = { options, request, response, url, params, readJson: readJson(request) };
        try { await route.handle(context); }
        catch (error) {
          if (!(error instanceof HttpError) || response.headersSent) throw error;
          sendJson(response, error.status, { error: error.message });
        }
        return;
      }
      if (request.method !== "GET") { response.writeHead(405).end(); return; }
      if (url.pathname.startsWith("/api/") || !options.staticDir) { response.writeHead(404).end(); return; }
      await sendStatic(response, options.staticDir, (request.url ?? "/").split("?", 1)[0], token);
    })().catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address && typeof address !== "string") port = address.port;
  return server;
}
