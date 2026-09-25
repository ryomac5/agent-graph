// fixture を配る小さな静的サーバ。撮影と目視の確認に使う。
// node packages/dashboard/scripts/preview.ts [--port 4311] [--project test/fixtures/project.json] [--overview test/fixtures/overview.json]
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option("port", process.env.PORT || "4311"));
const projectPath = resolve(here, option("project", "../test/fixtures/project.json"));
const overviewPath = resolve(here, option("overview", "../test/fixtures/overview.json"));
const staticDir = resolve(here, "../public");
const TOKEN = "preview-token";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/api/overview") { sendJson(response, 200, await loadJson(overviewPath)); return; }
    if (request.method === "GET" && url.pathname === "/api/project") {
      const view = await loadJson(projectPath) as { project: { key: string } };
      const repo = url.searchParams.get("repo");
      if (repo && repo !== view.project.key) { sendJson(response, 404, { error: "Repository not found" }); return; }
      sendJson(response, 200, view);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const repo = url.searchParams.get("repo");
      if (repo !== null) {
        const view = await loadJson(projectPath) as { project: { key: string } };
        if (repo !== view.project.key) { sendJson(response, 404, { error: "Repository not found" }); return; }
      }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      const send = async (): Promise<void> => {
        const data = await loadJson(repo === null ? overviewPath : projectPath);
        response.write(`event: ${repo === null ? "overview" : "project"}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      await send();
      const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
      // fixture を書き換えたら 2 秒以内に反映する
      const poll = setInterval(() => { void send(); }, 2000);
      response.once("close", () => { clearInterval(keepAlive); clearInterval(poll); });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      if (request.headers["x-agent-graph-token"] !== TOKEN) { sendJson(response, 403, { error: "Token mismatch" }); return; }
      let body = "";
      request.setEncoding("utf8");
      for await (const chunk of request) body += chunk;
      const action = JSON.parse(body || "{}") as { action?: string; taskId?: string; sessionId?: string; turnId?: string };
      sendJson(response, 200, { ok: true, message: `${action.taskId ?? action.turnId ?? action.sessionId ?? ""} を ${action.action ?? "?"} した (preview)` });
      return;
    }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (url.pathname.startsWith("/api/")) { sendJson(response, 404, { error: "Not found" }); return; }
    const root = await realpath(staticDir);
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(`..${sep}`)) { response.writeHead(403).end(); return; }
    try {
      if (!(await stat(path)).isFile()) { response.writeHead(404).end(); return; }
    } catch { response.writeHead(404).end(); return; }
    if (rel === "index.html") {
      const html = await readFile(path, "utf8");
      const end = html.indexOf(">", html.search(/<head[^>]*>/i)) + 1;
      response.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      response.end(`${html.slice(0, end)}\n  <meta name="agent-graph-token" content="${TOKEN}">${html.slice(end)}`);
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  })().catch((error: unknown) => {
    if (!response.headersSent) sendJson(response, 500, { error: String(error) });
    else response.destroy();
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`dashboard preview http://127.0.0.1:${port}/  project=${projectPath}  overview=${overviewPath}`);
});
