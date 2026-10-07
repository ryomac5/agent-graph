import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { openLedger, type FactInput } from "../../core/src/ledger/index.ts";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import type { RunnerEvent, RunnerRequest } from "../src/runner-client.ts";

type ApiServer = Awaited<ReturnType<typeof startWebSocketServer>>;
const TIMEOUT_MS = 5000;
const facts = JSON.parse(readFileSync(new URL("./samples/S17/input.json", import.meta.url), "utf8")) as FactInput[];
function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ag-ws-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "ledger.db");
  const runnerPath = join(directory, "runner.sock");
  const service = openObservationService({ dbPath });
  let closed = false;
  function closeService() { if (!closed) { closed = true; service.close(); } }
  t.after(closeService);
  return { directory, dbPath, runnerPath, service, closeService };
}
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out");
    await delay(10);
  }
}
async function createRunner(path: string) {
  const clients = new Set<Socket>();
  const accepted = new Set<Socket>();
  const results = new Map<string, { type: string; cmd_id: string; ok: boolean; result: { starts: number } }>();
  const requests: RunnerRequest[] = [];
  let starts = 0;
  let dropResponse = false;
  const server = createServer((socket) => {
    clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clients.delete(socket); accepted.delete(socket); });
    socket.on("data", (data) => {
      buffer += data;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!accepted.has(socket)) {
          assert.deepEqual(message, { type: "hello", version: 1, role: "api" });
          accepted.add(socket);
          socket.write(JSON.stringify({ type: "hello", version: 1, role: "runner" }) + "\n");
          continue;
        }
        assert.equal(message.type, "req");
        requests.push(message);
        let result = results.get(message.cmd_id);
        if (!result) {
          starts++;
          result = { type: "res", cmd_id: message.cmd_id, ok: true, result: { starts } };
          results.set(message.cmd_id, result);
        }
        if (dropResponse) { dropResponse = false; socket.destroy(); }
        else socket.write(JSON.stringify(result) + "\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return {
    requests, get starts() { return starts; },
    dropNextResponse() { dropResponse = true; },
    publish(event: RunnerEvent) { for (const socket of accepted) socket.write(JSON.stringify(event) + "\n"); },
    disconnect() { for (const socket of clients) socket.destroy(); },
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
async function connect(api: ApiServer, seq = 0, extra: object = {}) {
  const socket = new WebSocket(`${api.wsUrl}?token=${api.token}`, { origin: api.url });
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "hello", seq, ...extra }));
  await new Promise<void>((resolve) => { socket.once("pong", resolve); socket.ping(); });
  return { socket, messages, send(message: object) { socket.send(JSON.stringify(message)); },
    async next(type: string) {
      await waitUntil(() => messages.some((message) => message.type === type));
      return messages.splice(messages.findIndex((message) => message.type === type), 1)[0];
    } };
}
async function snapshot(api: ApiServer) {
  const response = await fetch(`${api.url}/snapshot`, { headers: { "x-agent-graph-token": api.token, Origin: api.url } });
  assert.equal(response.status, 200);
  return response.json() as Promise<any>;
}

testSocket("patch replay, subscription, evt delta and 500ms ledger tracking without evt", async (t) => {
  const { service, runnerPath } = createFixture(t);
  const runner = await createRunner(runnerPath);
  t.after(() => runner.close());
  const api = await startWebSocketServer(service, { port: 0, runnerPath });
  t.after(() => api.close());
  await waitUntil(() => api.runner.available);
  const client = await connect(api);
  service.ledger.append(facts[0]);
  const patch = await client.next("patch");
  assert.equal(patch.seq, 1);
  assert.deepEqual(Object.keys(patch.changes), ["delegations"]);
  assert.equal(patch.changes.delegations.upsert[0].id, "s17");
  client.socket.terminate();
  service.ledger.append(facts[1]);
  runner.publish({ type: "evt", seq: 2 });
  // snapshot の位置を境界にし、切断中の差分が保持されたことを確かめる。
  assert.equal((await snapshot(api)).seq, 2);
  const resumed = await connect(api, 1);
  assert.equal((await resumed.next("patch")).seq, 2);
  const scoped = await connect(api, 2, { scope: { tables: ["runs"] } });
  service.ledger.append(facts[2]);
  runner.publish({ type: "evt", seq: 3 });
  const scopedPatch = await scoped.next("patch");
  assert.deepEqual(Object.keys(scopedPatch.changes), ["runs"]);
  resumed.send({ type: "hello", seq: 3, scope: { conversations: [scopedPatch.changes.runs.upsert[0].conversation_id] } });
  await new Promise<void>(resolve => { resumed.socket.once("pong", resolve); resumed.socket.ping(); });
  runner.publish({ type: "evt", delta: { runId: "child", text: "hello" } });
  assert.deepEqual(await resumed.next("delta"), { type: "delta", runId: "child", text: "hello" });
  const current = await snapshot(api);
  assert.equal(current.seq, 3);
  assert.equal(current.projection.runs.length, 1);
});

testSocket("resync after retention exhaustion and projection rebuild", async (t) => {
  const { service, runnerPath } = createFixture(t);
  const api = await startWebSocketServer(service, { port: 0, runnerPath, patchRetention: 1 });
  t.after(() => api.close());
  const client = await connect(api);
  service.ledger.append(facts[0]);
  await client.next("patch");
  service.ledger.append(facts[1]);
  await client.next("patch");
  const old = await connect(api, 0);
  assert.equal((await old.next("resync")).type, "resync");
  const current = await snapshot(api);
  const fresh = await connect(api, current.seq, { generation: current.generation });
  service.rebuild();
  await fresh.next("resync");
  const staleGeneration = await connect(api, current.seq, { generation: current.generation });
  await staleGeneration.next("resync");
  assert.equal((await snapshot(api)).generation, current.generation + 1);
});

testSocket("cmd preserves cmd_id, retries lost responses once and acknowledges unavailable runner", async (t) => {
  const { service, runnerPath } = createFixture(t);
  const api = await startWebSocketServer(service, { port: 0, runnerPath });
  t.after(() => api.close());
  const client = await connect(api);
  client.send({ type: "cmd", cmd_id: "unavailable", command: "start" });
  assert.deepEqual(await client.next("ack"), { type: "ack", cmd_id: "unavailable", ok: false, error: "Runner unavailable" });
  const runner = await createRunner(runnerPath);
  t.after(() => runner.close());
  await waitUntil(() => api.runner.available);
  runner.dropNextResponse();
  const command = { type: "cmd", cmd_id: "stable", command: "start", payload: { runId: "child" } };
  client.send(command);
  const ack = await client.next("ack");
  assert.deepEqual(ack, { type: "ack", cmd_id: "stable", ok: true, result: { starts: 1 } });
  assert.equal(runner.requests.length, 2);
  assert.deepEqual(runner.requests[0], { ...command, type: "req" });
  client.send(command);
  assert.deepEqual(await client.next("ack"), ack);
  assert.equal(runner.starts, 1);
});

testSocket("token, Origin and Host rejection protects websocket and HTTP snapshot", async (t) => {
  const { service, runnerPath } = createFixture(t);
  const api = await startWebSocketServer(service, { port: 0, runnerPath });
  t.after(() => api.close());
  for (const [token, origin, host] of [["wrong", api.url, undefined], [api.token, "http://evil.invalid", undefined],
    [api.token, api.url, "evil.invalid"]]) {
    const socket = new WebSocket(`${api.wsUrl}?token=${token}`, { origin, headers: host ? { Host: host } : {} });
    const status = await new Promise<number>((resolve, reject) => {
      socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.on("error", () => {});
      socket.on("open", () => reject(new Error("Unauthorized websocket accepted")));
    });
    assert.equal(status, 403);
  }
  assert.equal((await fetch(`${api.url}/snapshot`)).status, 403);
  assert.equal((await fetch(`${api.url}/snapshot`, { headers: { "x-agent-graph-token": api.token, Origin: "http://evil.invalid" } })).status, 403);
});

testSocket("S17: api restart keeps delegation running, starts once and rebuilds every durable event", async (t) => {
  const { service, dbPath, runnerPath, closeService } = createFixture(t);
  const runner = await createRunner(runnerPath);
  t.after(() => runner.close());
  let api = await startWebSocketServer(service, { port: 0, runnerPath });
  await waitUntil(() => api.runner.available);
  const client = await connect(api);
  const command = { type: "cmd", cmd_id: "s17-start", command: "delegate" };
  client.send(command);
  await client.next("ack");
  for (const fact of facts.slice(0, 4)) service.ledger.append(fact);
  assert.equal((await snapshot(api)).projection.delegations[0].state, "running");
  const previousToken = api.token;
  await api.close();
  closeService();
  // runner 側の独立した接続が api 不在中も台帳に確定した事実を残す。
  const writer = openLedger(dbPath);
  for (const fact of facts.slice(4)) writer.append(fact);
  runner.publish({ type: "evt", seq: 7 });
  const durable = writer.readSince(0, Number.MAX_SAFE_INTEGER);
  const expectedLedger = JSON.parse(readFileSync(new URL("./samples/S17/expected-ledger.json", import.meta.url), "utf8"));
  assert.equal(durable.length, expectedLedger.count);
  assert.deepEqual(durable.map((fact) => fact.source_event_id), expectedLedger.source_event_ids);
  for (const fact of facts) assert.equal(writer.append(fact).status, "duplicate");
  writer.close();
  const restarted = openObservationService({ dbPath });
  api = await startWebSocketServer(restarted, { port: 0, runnerPath });
  t.after(async () => { await api.close(); restarted.close(); });
  assert.notEqual(api.token, previousToken);
  await waitUntil(() => api.runner.available);
  const resumed = await connect(api, 4);
  await resumed.next("resync");
  const result = await snapshot(api);
  resumed.send({ type: "hello", seq: result.seq, generation: result.generation });
  resumed.send(command);
  await resumed.next("ack");
  assert.equal(runner.starts, expectedLedger.starts);
  const expected = JSON.parse(readFileSync(new URL("./samples/S17/expected-projection.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(expected.delegation)) assert.deepEqual(result.projection.delegations[0][key], value);
  for (const [key, value] of Object.entries(expected.run)) assert.deepEqual(result.projection.runs[0][key], value);
  const detail = await (await fetch(`${api.url}/conversation?id=${encodeURIComponent(result.projection.runs[0].conversation_id)}`, { headers: { "x-agent-graph-token": api.token } })).json() as any;
  assert.equal(result.projection.messages, undefined);
  assert.deepEqual(detail.projection.messages, []);
  restarted.rebuild();
  assert.deepEqual((await snapshot(api)).projection, result.projection);
  const reversePath = join(dirname(dbPath), "reverse.db");
  const reverse = openObservationService({ dbPath: reversePath });
  try {
    for (const fact of [...facts].reverse()) reverse.ledger.append(fact);
    const reverseApi = await startWebSocketServer(reverse, { port: 0, runnerPath });
    try { assert.deepEqual((await snapshot(reverseApi)).projection, result.projection); }
    finally { await reverseApi.close(); }
  } finally { reverse.close(); }
});


// 隔離環境でも通信を許す環境では必ず本物の待受で検証する。
function testSocket(name: string, action: (t: TestContext) => Promise<void>): void {
  test(name, { timeout: 15_000 }, async (t) => {
    try { await action(t); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM"
        && "syscall" in error && error.syscall === "listen")) throw error;
      t.skip("sandbox blocks local TCP/Unix socket listen");
    }
  });
}

test("S17 durable recovery, replay and rebuild are verifiable without sockets", (t) => {
  const { service, dbPath, directory, closeService } = createFixture(t);
  let feed = new ProjectionFeed(dbPath, service.catchUp, 1);
  for (const fact of facts.slice(0, 4)) service.ledger.append(fact);
  const patch = feed.refresh();
  assert.ok(patch && patch !== "resync");
  assert.equal(patch.seq, 4);
  assert.equal(patch.changes.delegations.upsert[0].state, "running");
  assert.equal(feed.replay(0)?.length, 1);
  feed.close();
  closeService();
  const writer = openLedger(dbPath);
  for (const fact of facts.slice(4)) writer.append(fact);
  for (const fact of facts) assert.equal(writer.append(fact).status, "duplicate");
  const expectedLedger = JSON.parse(readFileSync(new URL("./samples/S17/expected-ledger.json", import.meta.url), "utf8"));
  const durable = writer.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(durable.map((fact) => fact.source_event_id), expectedLedger.source_event_ids);
  assert.equal(durable.length, expectedLedger.count);
  writer.close();
  const restarted = openObservationService({ dbPath });
  t.after(() => restarted.close());
  feed = new ProjectionFeed(dbPath, restarted.catchUp);
  t.after(() => feed.close());
  assert.equal(feed.snapshot().seq, 7);
  assert.equal(feed.replay(4), undefined);
  const result = feed.snapshot().projection;
  const expected = JSON.parse(readFileSync(new URL("./samples/S17/expected-projection.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(expected.delegation)) assert.deepEqual(result.delegations[0][key], value);
  for (const [key, value] of Object.entries(expected.run)) assert.deepEqual(result.runs[0][key], value);
  const detail = feed.conversation(String(result.runs[0].conversation_id));
  assert.equal(result.messages, undefined);
  assert.deepEqual(detail.projection.messages, []);
  restarted.rebuild();
  assert.equal(feed.refresh(), "resync");
  assert.equal(feed.replay(7), undefined);
  assert.deepEqual(feed.replay(7, feed.snapshot().generation), []);
  assert.deepEqual(feed.snapshot().projection, result);
  const reversed = openObservationService({ dbPath: join(directory, "reversed.db") });
  const reverseFeed = new ProjectionFeed(reversed.dbPath, reversed.catchUp, 1);
  try {
    for (const fact of [...facts].reverse()) reversed.ledger.append(fact);
    reverseFeed.refresh();
    assert.deepEqual(reverseFeed.snapshot().projection, result);
    reversed.ledger.append({ ...facts[0], kind: "delegation.created", source_event_id: "s17-extra", subject: "delegation:other",
      payload: { request_id: "other", role: "implementer", title: "[redacted]", attempt: 1, state: "received" } });
    reverseFeed.refresh();
    assert.equal(reverseFeed.replay(0), undefined);
    const replay = reverseFeed.replay(7)!;
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].changes.delegations.remove, []);
  } finally { reverseFeed.close(); reversed.close(); }
});

test("security rules reject invalid token, cross Origin, DNS Host and non-loopback peers without sockets", async () => {
  const { authorize, createToken } = await import("../src/ws/security.ts");
  const token = createToken();
  assert.notEqual(createToken(), token);
  const request = {
    headers: { host: "127.0.0.1:7421", origin: "http://127.0.0.1:7421", "x-agent-graph-token": token },
    socket: { remoteAddress: "127.0.0.1" }, url: "/ws",
  };
  function check(headers: object = {}, remoteAddress = "127.0.0.1", url = "/ws") {
    return authorize({ ...request, headers: { ...request.headers, ...headers },
      socket: { remoteAddress }, url } as unknown as import("node:http").IncomingMessage, 7421, token);
  }
  assert.equal(check(), true);
  assert.equal(check({ "x-agent-graph-token": "wrong" }), false);
  assert.equal(check({ "x-agent-graph-token": token + "x" }), false);
  assert.equal(check({ origin: "http://evil.invalid" }), false);
  assert.equal(check({ host: "evil.invalid:7421" }), false);
  assert.equal(check({}, "192.0.2.1"), false);
  assert.equal(check({ "x-agent-graph-token": undefined }, "127.0.0.1", `/ws?token=${token}`), true);
  assert.equal(check({ "x-agent-graph-token": undefined }), false);
  assert.equal(check({ "x-agent-graph-token": undefined }, "127.0.0.1", "http://["), false);
  assert.equal(check({ origin: undefined }), true);
});

test("runner wire handshake, fragmented frames and lost-response reconnect preserve command identity without sockets", async (t) => {
  const net = await import("node:net");
  const { EventEmitter } = await import("node:events");
  const { syncBuiltinESMExports } = await import("node:module");
  const { RunnerClient } = await import("../src/runner-client.ts");
  let starts = 0;
  const results = new Map<string, object>();
  const requests: RunnerRequest[] = [];
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventEmitter {
    destroyed = false;
    setEncoding() { return this; }
    write(frame: string) {
      const message = JSON.parse(frame);
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (message.type === "hello") {
          assert.deepEqual(message, { type: "hello", version: 1, role: "api" });
          this.emit("data", '{"type":"hello","version":');
          this.emit("data", '1,"role":"runner"}\n');
          return;
        }
        requests.push(message);
        if (!results.has(message.cmd_id)) {
          starts++;
          results.set(message.cmd_id, { type: "res", cmd_id: message.cmd_id, ok: true, result: { starts } });
          this.destroy();
        } else this.emit("data", JSON.stringify(results.get(message.cmd_id)) + "\n");
      });
      return true;
    }
    destroy() {
      if (!this.destroyed) { this.destroyed = true; this.emit("close"); }
      return this;
    }
  }
  const stub = t.mock.method(net.default, "createConnection", () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
  syncBuiltinESMExports();
  const events: RunnerEvent[] = [];
  const client = new RunnerClient("unused.sock", (event) => events.push(event));
  try {
    await waitUntil(() => client.available);
    const command: RunnerRequest = { type: "req", cmd_id: "once", command: "delegate", payload: { text: "[redacted]" } };
    const pending = client.request(command);
    assert.equal(client.request(command), pending);
    assert.deepEqual(await pending, { type: "res", cmd_id: "once", ok: true, result: { starts: 1 } });
    assert.deepEqual(requests, [command, command]);
    assert.equal(starts, 1);
    sockets.at(-1)!.emit("data", '{"type":"evt","seq":7}\n{"type":"evt","delta":{"runId":"child","text":"hello"}}\n');
    assert.deepEqual(events, [{ type: "evt", seq: 7 }, { type: "evt", delta: { runId: "child", text: "hello" } }]);
    sockets.at(-1)!.emit("data", "not json\n");
    assert.equal(client.available, false);
    assert.deepEqual(await client.request({ ...command, cmd_id: "absent" }), {
      type: "res", cmd_id: "absent", ok: false, error: "Runner unavailable",
    });
  } finally {
    client.close();
    stub.mock.restore();
    syncBuiltinESMExports();
  }
});

test("snapshot と /conversation と patch の会話の行に、core の投影の名前と依頼の抜粋を必ず載せる", (t) => {
  const { service, dbPath } = createFixture(t);
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  t.after(() => feed.close());
  const base = { source: "rollout-codex", source_ts: "2026-10-07T01:46:00.000Z", confidence: "confirmed" } as const;
  const conversation = (id: string, type: string): FactInput => ({ ...base, source_event_id: `c-${id}`, kind: "conversation.created",
    subject: `conversation:${id}`, payload: { provider: "codex", native_id: id, origin: "observed", type, history_format: "paginated" } } as FactInput);
  const message = (id: string, role: string, body: string, second: number): FactInput => ({ ...base,
    source_ts: new Date(Date.parse(base.source_ts) + second * 1000).toISOString(), source_event_id: `m-${id}`, kind: "message.created",
    subject: `message:${id}`, payload: { provider: "codex", native_id: id, version: 1, role, body, body_state: "stored" } } as FactInput);
  const member = (conversationId: string, messageId: string): FactInput => ({ ...base, source_event_id: `${conversationId}-${messageId}`,
    kind: "message_membership.created", subject: `message_membership:${conversationId}-${messageId}`,
    payload: { message_id: messageId, conversation_id: conversationId, active: true } } as FactInput);
  for (const fact of [conversation("named", "interactive"), conversation("exec", "unattended"), conversation("empty", "interactive"),
    message("role", "developer", "<multi_agent_role>You are `/root`, the primary agent.\n</multi_agent_role>", 0),
    message("agents", "user", "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n規約\n</INSTRUCTIONS>", 1),
    message("request", "user", "# タスク D1: 画面への配信を作る\n本文", 2),
    ...["role", "agents", "request"].flatMap(id => [member("named", id), member("exec", id)])]) service.ledger.append(fact);
  const patch = feed.refresh();
  const rows = (list: Record<string, unknown>[]) => Object.fromEntries(list.map(row => [JSON.parse(String(row.id))[1],
    { name: row.name, name_is_provisional: row.name_is_provisional, first_request_excerpt: row.first_request_excerpt }]));
  const expected = {
    named: { name: "画面への配信を作る", name_is_provisional: true, first_request_excerpt: "画面への配信を作る" },
    exec: { name: "画面への配信を作る", name_is_provisional: true, first_request_excerpt: "画面への配信を作る" },
    empty: { name: null, name_is_provisional: false, first_request_excerpt: null },
  };
  assert.deepEqual(rows(feed.snapshot().projection.conversations), expected);
  assert.deepEqual(rows(feed.list("conversations").rows), expected);
  assert.ok(patch && patch !== "resync");
  assert.deepEqual(rows(patch.changes.conversations.upsert), expected);
  for (const [id, values] of Object.entries(expected)) {
    const detail = feed.conversation(JSON.stringify(["codex", id]));
    assert.deepEqual(rows(detail.projection.conversations), { [id]: values });
  }
});

test("同じ時刻の旧い rollout の発言は、行の位置を数として比べて最後の発言の抜粋を選ぶ", (t) => {
  const { service, dbPath } = createFixture(t);
  const base = { source: "rollout-codex", source_ts: "2025-08-30T15:23:40.934Z", confidence: "confirmed" } as const;
  service.ledger.append({ ...base, source_event_id: "c-legacy", kind: "conversation.created", subject: "conversation:legacy",
    payload: { provider: "codex", native_id: "legacy", origin: "observed", type: "interactive", history_format: "legacy" } } as FactInput);
  for (const [offset, body] of [[9999, "最初の依頼。"], [104048, "最後の応答"]] as const) {
    service.ledger.append({ ...base, source_event_id: `message:rollout-legacy.jsonl:${offset}:h:1`, kind: "message.created",
      subject: `message:m${offset}`, payload: { provider: "codex", native_id: `m${offset}`, version: 1, role: offset === 9999 ? "user" : "assistant", body, body_state: "stored" } } as FactInput);
    service.ledger.append({ ...base, source_event_id: `member-${offset}`, kind: "message_membership.created", subject: `message_membership:${offset}`,
      payload: { message_id: `m${offset}`, conversation_id: "legacy", active: true } } as FactInput);
  }
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  t.after(() => feed.close());
  const [row] = feed.snapshot().projection.conversations;
  assert.equal(row.name, "最初の依頼。");
  assert.equal(row.last_message_excerpt, "最後の応答");
});
