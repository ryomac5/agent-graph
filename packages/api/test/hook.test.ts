import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { openLedger, projectConversations, projectRuns } from "../../core/src/ledger/index.ts";
import type { Ledger } from "../../core/src/ledger/index.ts";
import { createHookHandler, startHookServer } from "../src/hook/index.ts";
import type { HookEvent } from "../src/hook/index.ts";

const nativeFetch = globalThis.fetch;

const EVENT: HookEvent = { version: 1, session_id: "session", generation: 1, event_id: "start",
  hook_event_name: "SessionStart", source_ts: "2026-01-01T00:00:00.000Z", input: {}, managed: false };

function createReceiver(ledger: Ledger) {
  const token = randomBytes(32).toString("base64url");
  const url = "http://127.0.0.1:12345/hook-v2";
  const handler = createHookHandler(ledger, token);
  const post = async (_url: string, options: RequestInit) => {
    const request = Readable.from([Buffer.from(String(options.body))]);
    Object.assign(request, { method: options.method, url: "/hook-v2",
      headers: { host: "127.0.0.1:12345", ...options.headers },
      socket: { remoteAddress: "127.0.0.1", localPort: 12345 } });
    let status = 0;
    let body = "";
    const response = { writeHead: (code: number) => { status = code; }, end: (value: string) => { body = value; } };
    await handler(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    return new Response(body, { status });
  };
  return { token, url, post, close: async () => {} };
}

test("hook を受理し、再送と受け口の再起動でも事実が増えない", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const first = createReceiver(ledger);
  const post = (receiver: ReturnType<typeof createReceiver>, token: string, event = EVENT) => receiver.post(receiver.url, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
  try {
    const response = await post(first, first.token);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
    assert.equal((await post(first, first.token)).status, 200);
    assert.equal(ledger.readSince(0, 100).length, 2);
    assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
  } finally { await first.close(); }
  const second = createReceiver(ledger);
  t.after(() => second.close());
  assert.notEqual(first.token, second.token);
  assert.equal((await post(second, first.token)).status, 403);
  assert.equal((await post(second, second.token)).status, 200);
  assert.equal(ledger.readSince(0, 100).length, 2);
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
  const ended = { ...EVENT, event_id: "end", hook_event_name: "SessionEnd", source_ts: "2026-01-01T00:01:00.000Z" };
  assert.equal((await post(second, second.token, ended)).status, 200);
  assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "ended");
  assert.equal((await post(second, second.token, { ...EVENT, generation: 2 })).status, 200);
  assert.equal(projectRuns(ledger.readSince(0, 100)).length, 2);
  assert.equal(globalThis.fetch, nativeFetch);
});

test("不正なトークン、Origin、入力を拒否し、台帳へ書かない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  for (const authorization of [undefined, "Bearer wrong", ""]) {
    const response = await receiver.post(receiver.url, { method: "POST", headers: {
      "content-type": "application/json", ...(authorization !== undefined ? { authorization } : {}),
    }, body: JSON.stringify(EVENT) });
    assert.equal(response.status, 403);
  }
  const headers = { "content-type": "application/json", authorization: `Bearer ${receiver.token}` };
  assert.equal((await receiver.post(receiver.url, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" },
    body: JSON.stringify(EVENT) })).status, 403);
  for (const body of ["{", JSON.stringify({ ...EVENT, generation: 0 }), JSON.stringify({ ...EVENT, run_id: 123 })]) {
    assert.equal((await receiver.post(receiver.url, { method: "POST", headers, body })).status, 400);
  }
  assert.equal(ledger.readSince(0, 100).length, 0);
});

test("agent_id 付きの hook でも親は interactive のままで、会話の作成は一度だけ", async (t) => {
  for (const childFirst of [false, true]) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const child: HookEvent = { ...EVENT, event_id: "child-tool", hook_event_name: "PostToolUse",
      source_ts: "2026-01-01T00:01:00.000Z", input: { agent_id: "child" } };
    const events = childFirst ? [child, EVENT] : [EVENT, child];
    const receivers = [createReceiver(ledger), createReceiver(ledger)];
    for (const [index, event] of [...events, { ...EVENT, generation: 2, event_id: "resume",
      source_ts: "2026-01-01T00:02:00.000Z" }, child].entries()) {
      const receiver = receivers[index % receivers.length];
      const response = await receiver.post(receiver.url, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
        body: JSON.stringify(event) });
      assert.equal(response.status, 200);
      const facts = ledger.readSince(0, 100);
      assert.equal(facts.filter((fact) => fact.kind === "conversation.created").length, 1);
      const conversations = projectConversations(facts).conversations;
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0].native_id, EVENT.session_id);
      assert.equal(conversations[0].type, "interactive");
    }
    assert.equal(ledger.readSince(0, 100).length, 4);
  }
});

test("Stop の後の UserPromptSubmit で running に戻り、逆順の到着や再送でも崩れない", async (t) => {
  const stopped: HookEvent = { ...EVENT, event_id: "stop", hook_event_name: "Stop",
    source_ts: "2026-01-01T00:01:00.000Z" };
  const prompted: HookEvent = { ...EVENT, event_id: "prompt", hook_event_name: "UserPromptSubmit",
    source_ts: "2026-01-01T00:02:00.000Z" };
  for (const events of [[EVENT, stopped, prompted], [prompted, stopped, EVENT]]) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const receiver = createReceiver(ledger);
    for (const event of [...events, stopped, prompted]) {
      const response = await receiver.post(receiver.url, { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` },
        body: JSON.stringify(event) });
      assert.equal(response.status, 200);
      if (event === stopped && events[0] === EVENT && ledger.readSince(0, 100).length === 3) {
        assert.equal(projectRuns(ledger.readSince(0, 100))[0].state, "idle");
      }
    }
    const facts = ledger.readSince(0, 100);
    assert.equal(facts.length, 4);
    assert.equal(projectRuns(facts)[0].state, "running");
    assert.equal(projectRuns(facts)[0].last_evidence_ts, prompted.source_ts);
  }
});

test("managed の hook は補助事実だけを記録し、ホストの状態を変えない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  ledger.append({ source: "host-claude", source_event_id: "host-start", kind: "run.created", subject: "run:managed",
    payload: { conversation_id: "managed-conversation", generation: 1, state: "running" },
    source_ts: EVENT.source_ts, confidence: "confirmed" });
  const event = { ...EVENT, managed: true, run_id: "managed", hook_event_name: "SessionEnd",
    source_ts: "2026-01-01T00:01:00.000Z", input: { password: "sk-ant-abcdefghijklmnopqrstuvwxyz" } };
  const post = () => receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify(event) });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, 2);
  assert.equal(facts[1].kind, "run.updated");
  assert.equal(facts[1].source, "hook");
  assert.equal(facts[1].payload?.generation, event.generation);
  assert.equal(projectRuns(facts)[0].state, "running");
  assert.ok(!JSON.stringify(facts).includes("sk-ant-abcdefghijklmnopqrstuvwxyz"));
  const auxiliary = await receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify({ ...event, event_id: "without-run", run_id: undefined }) });
  assert.equal(auxiliary.status, 200);
  assert.equal(ledger.readSince(0, 100).length, 3);
  assert.equal(projectRuns(ledger.readSince(0, 100)).length, 1);
});

test("同じ出来事 ID の内容が変わった場合は受理しない", async (t) => {
  const ledger = openLedger(":memory:");
  const receiver = createReceiver(ledger);
  t.after(async () => { await receiver.close(); ledger.close(); });
  for (const [input, expected] of [[{}, 200], [{ changed: true }, 409]] as const) {
    const response = await receiver.post(receiver.url, { method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${receiver.token}` }, body: JSON.stringify({ ...EVENT, input }) });
    assert.equal(response.status, expected);
  }
  assert.equal(ledger.readSince(0, 100).length, 2);
});

test("大きな hook の本文も欠落なく台帳へ届け、再送で増やさない", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const receiver = createReceiver(ledger);
  const input = { tool_response: "結果😀".repeat(150_000) };
  const body = JSON.stringify({ ...EVENT, event_id: "large", input });
  assert.ok(Buffer.byteLength(body) > 1_048_576);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await receiver.post(receiver.url, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}` }, body });
    assert.equal(response.status, 200);
  }
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, 2);
  assert.ok(facts[1].kind === "run.created");
  assert.deepEqual((facts[1].payload?.last_evidence as { input: unknown }).input, input);
});

test("実 HTTP の受け口は 127.0.0.1 に限定する", async (t) => {
  assert.equal(globalThis.fetch, nativeFetch);
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  let receiver: Awaited<ReturnType<typeof startHookServer>>;
  try { receiver = await startHookServer(ledger); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("sandbox blocks local HTTP listen");
    return;
  }
  t.after(() => receiver.close());
  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  const response = await fetch(receiver.url, { method: "POST", headers: { "content-type": "application/json",
    authorization: `Bearer ${receiver.token}` }, body: JSON.stringify(EVENT) });
  assert.equal(response.status, 200);
});
