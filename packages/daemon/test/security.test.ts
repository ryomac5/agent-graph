import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repoKey } from "../../core/src/paths.ts";
import { openStore } from "../../core/src/store/store.ts";
import { TOKEN_HEADER } from "../src/http/contract.ts";
import { allowedHosts, injectToken, rejectPost } from "../src/http/security.ts";
import { startHttpServer } from "../src/http/server.ts";

function raw(port: number, options: { method: string; path: string; headers?: Record<string, string>; body?: string }):
  Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port, method: options.method, path: options.path,
      headers: options.headers ?? {} }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    client.on("error", reject);
    client.end(options.body);
  });
}

test("許可する Host はループバック名にポートを付けたものだけ", () => {
  const hosts = allowedHosts(4321);
  assert.deepEqual([...hosts].sort(), ["127.0.0.1:4321", "[::1]:4321", "localhost:4321"]);
  assert.ok(!hosts.has("127.0.0.1"));
  assert.ok(!hosts.has("evil.example:4321"));
});

test("index.html の head にトークンの meta を埋め込む", () => {
  const html = injectToken("<!doctype html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n</head>\n<body></body></html>", "abc");
  assert.match(html, /<head>\n {2}<meta name="agent-graph-token" content="abc">\n {2}<meta charset="utf-8">/);
  assert.match(injectToken("plain", "abc"), /^<meta name="agent-graph-token" content="abc">\nplain$/);
});

test("rejectPost は Content-Type、Origin、トークン、接続元の順に判定する", () => {
  const make = (headers: Record<string, string>, remoteAddress = "127.0.0.1") =>
    ({ headers, socket: { remoteAddress } }) as unknown as import("node:http").IncomingMessage;
  const json = { host: "127.0.0.1:1", "content-type": "application/json; charset=utf-8" };
  assert.match(rejectPost(make({ host: "127.0.0.1:1" }), "token", "t") ?? "", /Content-Type/);
  assert.match(rejectPost(make({ ...json, origin: "http://evil.example" }), "token", "t") ?? "", /Origin/);
  assert.match(rejectPost(make({ ...json, origin: "http://127.0.0.1:1" }), "token", "t") ?? "", /token/);
  assert.match(rejectPost(make({ ...json, [TOKEN_HEADER]: "x" }), "token", "t") ?? "", /token/);
  assert.equal(rejectPost(make({ ...json, [TOKEN_HEADER]: "t" }), "token", "t"), undefined);
  assert.equal(rejectPost(make(json), "loopback", "t"), undefined);
  assert.equal(rejectPost(make(json, "::ffff:127.0.0.1"), "loopback", "t"), undefined);
  assert.match(rejectPost(make(json, "10.0.0.1"), "loopback", "t") ?? "", /Local/);
});

test("HTTP は Host、Origin、トークン、hook 経路をそれぞれ守る", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-security-")));
  execFileSync("git", ["init", "-q", root]);
  const key = repoKey(root);
  const store = openStore(":memory:");
  store.upsertRepo({ key, rootPath: root, name: "test" });
  const staticDir = join(root, "public");
  mkdirSync(staticDir);
  const tokenPath = join(root, "run", "dashboard.token");
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  let server;
  try {
    server = await startHttpServer({ port: 0, openStores: new Map([[key, store]]), listRepos: () => [], staticDir, tokenPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("HTTP listen is prohibited by the sandbox"); return; }
    throw error;
  }
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const token = readFileSync(tokenPath, "utf8").trim();
  const host = `127.0.0.1:${port}`;
  const json = { host, "content-type": "application/json" };
  const session = JSON.stringify({ id: "s", cwd: root, client: "claude" });

  // Host の拒否。GET も POST も 403
  for (const bad of ["evil.example", `evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
    assert.equal((await raw(port, { method: "GET", path: "/api/repos", headers: { host: bad } })).status, 403, bad);
  }
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions",
    headers: { ...json, host: `evil.example:${port}` }, body: session })).status, 403);
  for (const ok of [host, `localhost:${port}`, `[::1]:${port}`]) {
    assert.equal((await raw(port, { method: "GET", path: "/api/repos", headers: { host: ok } })).status, 200, ok);
  }

  // Content-Type の欠落
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions", headers: { host }, body: session })).status, 403);

  // Origin の不一致。一致すれば通る
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions",
    headers: { ...json, origin: "http://evil.example" }, body: session })).status, 403);
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions",
    headers: { ...json, origin: `http://${host}` }, body: session })).status, 201);

  // トークンの欠落と不一致。ダッシュボード用の経路は hook と違い接続元だけでは通らない
  const action = JSON.stringify({ action: "approve", repo: key });
  assert.equal((await raw(port, { method: "POST", path: "/api/action", headers: json, body: action })).status, 403);
  assert.equal((await raw(port, { method: "POST", path: "/api/action",
    headers: { ...json, [TOKEN_HEADER]: "wrong" }, body: action })).status, 403);
  assert.equal((await raw(port, { method: "POST", path: "/api/action",
    headers: { ...json, [TOKEN_HEADER]: token }, body: action })).status, 501);

  // hook 用の 3 経路はトークン無しで通る。未実装の経路は 501
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions", headers: json, body: session })).status, 201);
  assert.equal((await raw(port, { method: "POST", path: "/api/sessions/s/end", headers: json, body: "{}" })).status, 501);
  assert.equal((await raw(port, { method: "POST", path: "/api/observe", headers: json, body: "{}" })).status, 501);

  // 未知の POST は 405、未知の GET /api は 404
  assert.equal((await raw(port, { method: "POST", path: "/api/unknown", headers: json, body: "{}" })).status, 405);
  assert.equal((await raw(port, { method: "GET", path: "/api/unknown", headers: { host } })).status, 404);
});
