import assert from "node:assert/strict";
import test from "node:test";
import { sendAction, TOKEN_HEADER } from "../public/ui/action.js";

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };

function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test("操作は /api/action に契約の項目だけを送り、X-Agent-Graph-Token を付ける", async () => {
  const calls: Call[] = [];
  const notices: string[] = [];
  const result = await sendAction(
    { action: "approve", repo: "r", graphId: "g", taskId: "T", sessionId: "s", nodeId: "T", extra: 1 },
    { fetch: fakeFetch(200, { ok: true, message: "T を承認した" }, calls), token: "tok", notify: (m) => notices.push(m) },
  );
  assert.deepEqual(result, { ok: true, message: "T を承認した" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/action");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers[TOKEN_HEADER], "tok");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { action: "approve", repo: "r", graphId: "g", taskId: "T", sessionId: "s" });
  assert.deepEqual(notices, ["T を承認した"]);
});

test("403 は Failed のトーストになる", async () => {
  const notices: string[] = [];
  const result = await sendAction({ action: "retry", repo: "r" }, { fetch: fakeFetch(403, { error: "Token mismatch" }, []), notify: (m) => notices.push(m) });
  assert.equal(result.ok, false);
  assert.deepEqual(notices, ["Failed: Token mismatch"]);
});

test("ネットワークの失敗は Failed のトーストになる", async () => {
  const notices: string[] = [];
  const result = await sendAction({ action: "reject", repo: "r" }, { fetch: async () => { throw new Error("fetch failed"); }, notify: (m) => notices.push(m) });
  assert.deepEqual(result, { ok: false, message: "Failed: fetch failed" });
  assert.deepEqual(notices, ["Failed: fetch failed"]);
});

test("200 でも ActionResult の ok が偽なら Failed のトーストになる", async () => {
  const notices: string[] = [];
  const result = await sendAction({ action: "approve", repo: "r", graphId: "g", taskId: "T" }, { fetch: fakeFetch(200, { ok: false, message: "T は判断待ちではない" }, []), notify: (m) => notices.push(m) });
  assert.equal(result.ok, false);
  assert.deepEqual(notices, ["Failed: T は判断待ちではない"]);
});

test("JSON でない応答は Server error になる", async () => {
  const notices: string[] = [];
  const fetch = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("bad"); } });
  const result = await sendAction({ action: "end_session", repo: "r", sessionId: "s" }, { fetch, notify: (m) => notices.push(m) });
  assert.deepEqual(result, { ok: false, message: "Server error 502" });
  assert.deepEqual(notices, ["Failed: Server error 502"]);
});
