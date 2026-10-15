import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PROJECTION_TABLES } from "../../core/src/ledger/rebuild.ts";
import { WebSocket } from "ws";
import { openLedger, type FactInput } from "../../core/src/ledger/index.ts";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import type { RunnerEvent, RunnerRequest } from "../src/runner-client.ts";

type ApiServer = Awaited<ReturnType<typeof startWebSocketServer>>;
const TIMEOUT_MS = 5000;
const facts = JSON.parse(readFileSync(new URL("./samples/S17/input.json", import.meta.url), "utf8")) as FactInput[];
// 永続投影は配信時の現在状態による上書き前の全テーブルを厳密に比較する。
function readDurableProjection(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(PROJECTION_TABLES.map(table => [table,
      db.prepare(`SELECT * FROM ${table}`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  } finally { db.close(); }
}
// 今の状態の patch は台帳の seq を進めず（from_seq === seq）、判定と評価時刻だけを配り直す。
// state-decisions.md「API と画面への接続」: 事実の seq が進まなくても期限で再評価し、評価時刻は patch の外側の evaluated_at で配る。
// state-contract.md 6.3: 画面の接続には最新の版を返す。hello への応答は、再送の patch の後に今の状態の patch を 1 件送る。
const CURRENT_STATE_TABLES = ["runs", "state_decisions", "conversations", "roots"];
function assertCurrentStatePatch(patch: any, seq: number): void {
  assert.equal(patch.type, "patch");
  assert.equal(patch.from_seq, seq);
  assert.equal(patch.seq, seq);
  assert.equal(typeof patch.evaluated_at, "number");
  for (const table of Object.keys(patch.changes)) assert.ok(CURRENT_STATE_TABLES.includes(table), `${table} is not current state`);
}
// S17 の実行の行を、長く残る投影の欄と今の状態の欄に分けて確かめる。
// 長く残る欄（expected.run）は台帳から作り直せるので、配信の行と永続の runs 表の両方で厳密に一致させる。
// 今の状態の欄（state と判定）は走査の証拠と評価時刻から作られ、作り直しでは再現しない。与えた走査ごとの期待と比べる。
function assertS17Run(projection: any, durable: Record<string, any[]>, expectedRun: Record<string, unknown>,
  current: { state: string; hosting: string }, hostingEvidence: string[]): void {
  assert.equal(projection.runs.length, 1);
  assert.equal(durable.runs.length, 1);
  for (const [key, value] of Object.entries(expectedRun)) {
    assert.deepEqual(projection.runs[0][key], value);
    assert.deepEqual(durable.runs[0][key], value);
  }
  const decision = projection.state_decisions.find((row: any) => row.id === projection.runs[0].decision_id);
  assert.ok(decision, "run decision is delivered with the run");
  assert.equal(projection.runs[0].state, current.state);
  assert.equal(decision.hosting.value, current.hosting);
  assert.deepEqual(decision.hosting.evidenceIds, hostingEvidence);
}
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
  async function next(type: string) {
    await waitUntil(() => messages.some((message) => message.type === type));
    return messages.splice(messages.findIndex((message) => message.type === type), 1)[0];
  }
  return { socket, messages, next, send(message: object) { socket.send(JSON.stringify(message)); },
    // 台帳の seq を進める patch を待つ。間に届く再評価の patch は、今の状態の patch であることを確かめてから読み飛ばす。
    async nextLedgerPatch() {
      for (;;) {
        const patch = await next("patch");
        if (patch.from_seq < patch.seq) return patch;
        assertCurrentStatePatch(patch, patch.seq);
      }
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
  assertCurrentStatePatch(await client.next("patch"), 0);
  service.ledger.append(facts[0]);
  const patch = await client.nextLedgerPatch();
  assert.equal(patch.from_seq, 0);
  assert.equal(patch.seq, 1);
  // 実行の判定が変わらない patch は state_decisions を載せない。
  assert.deepEqual(Object.keys(patch.changes), ["delegations"]);
  assert.equal(patch.changes.delegations.upsert[0].id, "s17");
  client.socket.terminate();
  service.ledger.append(facts[1]);
  runner.publish({ type: "evt", seq: 2 });
  // snapshot の位置を境界にし、切断中の差分が保持されたことを確かめる。
  assert.equal((await snapshot(api)).seq, 2);
  const resumed = await connect(api, 1);
  const replayed = await resumed.next("patch");
  assert.equal(replayed.from_seq, 1);
  assert.equal(replayed.seq, 2);
  assertCurrentStatePatch(await resumed.next("patch"), 2);
  const scoped = await connect(api, 2, { scope: { tables: ["runs"] } });
  assertCurrentStatePatch(await scoped.next("patch"), 2);
  service.ledger.append(facts[2]);
  runner.publish({ type: "evt", seq: 3 });
  const scopedPatch = await scoped.nextLedgerPatch();
  // runs の行は decision_id だけを持ち、判定の本体は同じ patch の state_decisions で届く。
  // state-decisions.md「API と画面への接続」: state_decisions とその decision_id を配る。runs の購読は判定も含む。
  assert.deepEqual(Object.keys(scopedPatch.changes), ["runs", "state_decisions"]);
  assert.deepEqual(scopedPatch.changes.state_decisions.upsert.map((row: any) => row.id), [scopedPatch.changes.runs.upsert[0].decision_id]);
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
  assertCurrentStatePatch(await client.next("patch"), 0);
  // 保持数 1 を使い切るには、seq 1 と seq 2 を別々の patch にする。
  service.ledger.append(facts[0]);
  assert.equal((await client.nextLedgerPatch()).seq, 1);
  service.ledger.append(facts[1]);
  const second = await client.nextLedgerPatch();
  assert.equal(second.from_seq, 1);
  assert.equal(second.seq, 2);
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
  const scanAt = Date.now();
  api.feed.recordScan({ id: 's17-current-scan', at: scanAt, status: 'succeeded', sessions: [], processes: [] });
  api.feed.refresh(scanAt);
  const result = api.feed.snapshot();
  const durableProjection = readDurableProjection(dbPath);
  resumed.send({ type: "hello", seq: result.seq, generation: result.generation });
  resumed.send(command);
  await resumed.next("ack");
  assert.equal(runner.starts, expectedLedger.starts);
  const expected = JSON.parse(readFileSync(new URL("./samples/S17/expected-projection.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(expected.delegation)) assert.deepEqual(result.projection.delegations[0][key], value);
  // 成功した走査に child の登録がないので、所持は期限付きの not_hosted になる（R06、R10）。
  // 代表表示は Not hosted が Unknown より先に当たる（R32）。走査のない評価の unknown とは別の期待である。
  assertS17Run(result.projection, durableProjection, expected.run, expected.current_run.succeeded_scan_without_session, ["s17-current-scan"]);
  const detail = await (await fetch(`${api.url}/conversation?id=${encodeURIComponent(String(result.projection.runs[0].conversation_id))}`, { headers: { "x-agent-graph-token": api.token } })).json() as any;
  assert.equal(result.projection.messages, undefined);
  assert.deepEqual(detail.projection.messages, []);
  restarted.rebuild();
  await snapshot(api);
  assert.deepEqual(readDurableProjection(dbPath), durableProjection);
  const reversePath = join(dirname(dbPath), "reverse.db");
  const reverse = openObservationService({ dbPath: reversePath });
  try {
    for (const fact of [...facts].reverse()) reverse.ledger.append(fact);
    const reverseApi = await startWebSocketServer(reverse, { port: 0, runnerPath });
    try {
      const replayed = await snapshot(reverseApi);
      assert.equal(typeof replayed.evaluated_at, 'number');
      // 走査の証拠と評価時刻は台帳から再現できない現在状態である。
      // 再生先には別の照会結果を渡し、時刻の偶然の一致には依存しない。
      reverseApi.feed.recordScan({ id: 's17-replay-scan', at: scanAt + 1, status: 'failed', sessions: [], processes: [] });
      reverseApi.feed.refresh(scanAt + 1);
      const currentReplay = reverseApi.feed.snapshot();
      assert.notDeepEqual(currentReplay.projection.state_decisions, result.projection.state_decisions);
      assert.equal(durableProjection.state_decisions, undefined);
      assert.deepEqual(readDurableProjection(reversePath), durableProjection);
    }
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
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000_000_000 });
  const { service, dbPath, directory, closeService } = createFixture(t);
  let feed = new ProjectionFeed(dbPath, service.catchUp, 1);
  for (const fact of facts.slice(0, 4)) service.ledger.append(fact);
  const patch = feed.refresh(2_000_000_000_000);
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
  feed.refresh(2_000_000_000_000);
  const result = feed.snapshot().projection;
  const durableProjection = readDurableProjection(dbPath);
  const expected = JSON.parse(readFileSync(new URL("./samples/S17/expected-projection.json", import.meta.url), "utf8"));
  for (const [key, value] of Object.entries(expected.delegation)) assert.deepEqual(result.delegations[0][key], value);
  // 走査がなければ所持は判定できず、turn の証拠もないので Unknown になる（R06、R32）。
  assertS17Run(result, durableProjection, expected.run, expected.current_run.without_scan, []);
  const detail = feed.conversation(String(result.runs[0].conversation_id));
  assert.equal(result.messages, undefined);
  assert.deepEqual(detail.projection.messages, []);
  restarted.rebuild();
  assert.equal(feed.refresh(2_000_000_000_000), "resync");
  assert.equal(feed.replay(7), undefined);
  assert.deepEqual(feed.replay(7, feed.snapshot().generation), []);
  assert.deepEqual(readDurableProjection(dbPath), durableProjection);
  const reversed = openObservationService({ dbPath: join(directory, "reversed.db") });
  const reverseFeed = new ProjectionFeed(reversed.dbPath, reversed.catchUp, 1);
  try {
    for (const fact of [...facts].reverse()) reversed.ledger.append(fact);
    reverseFeed.refresh(2_000_000_000_000);
    assert.deepEqual(readDurableProjection(reversed.dbPath), durableProjection);
    // 同じ台帳でも別時刻の走査で現在状態は変わり、再構築の一致条件にはならない。
    const at = 2_000_000_000_001;
    reverseFeed.recordScan({ id: 's17-replay-scan', at, status: 'succeeded', sessions: [], processes: [] });
    reverseFeed.refresh(at);
    assert.notDeepEqual(reverseFeed.snapshot().projection.state_decisions, result.state_decisions);
    assert.equal(reverseFeed.snapshot().evaluated_at, at);
    assert.deepEqual(readDurableProjection(reversed.dbPath), durableProjection);
    reversed.ledger.append({ ...facts[0], kind: "delegation.created", source_event_id: "s17-extra", subject: "delegation:other",
      payload: { request_id: "other", role: "implementer", title: "[redacted]", attempt: 1, state: "received" } });
    reverseFeed.refresh(2_000_000_000_000);
    assert.equal(reverseFeed.replay(0), undefined);
    const replay = reverseFeed.replay(7)!;
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].changes.delegations.remove, []);
  } finally { reverseFeed.close(); reversed.close(); }
});

test("S17 decision identity survives clock changes, incremental ingestion, restart and reordered replay", t => {
  const now = 2_000_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const { service, dbPath, directory, closeService } = createFixture(t);
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  let feedClosed = false;
  const closeFeed = () => { if (!feedClosed) { feedClosed = true; feed.close(); } };
  t.after(closeFeed);
  for (const [index, fact] of facts.entries()) {
    service.ledger.append(fact);
    feed.refresh(now + index);
  }
  feed.recordScan({ id: 's17-initial-scan', at: now + facts.length, status: 'succeeded', sessions: [], processes: [] });
  feed.refresh(now + facts.length);
  const expected = feed.snapshot().projection;
  const durableProjection = readDurableProjection(dbPath);
  const decisionId = expected.runs[0].decision_id;
  assert.ok(expected.state_decisions.some(row => row.id === decisionId));
  const compare = (target: ProjectionFeed, at: number, path = dbPath) => {
    t.mock.timers.setTime(at);
    target.recordScan({ id: `s17-scan:${at}`, at, status: 'succeeded', sessions: [], processes: [] });
    target.refresh(at);
    const snapshot = target.snapshot();
    assert.equal(typeof snapshot.evaluated_at, 'number');
    assert.equal(snapshot.evaluated_at, at);
    assert.equal(snapshot.projection.runs[0].decision_id, decisionId);
    assert.notDeepEqual(snapshot.projection.state_decisions, expected.state_decisions);
    assert.deepEqual(readDurableProjection(path), durableProjection);
  };
  t.mock.timers.setTime(now + 1000);
  service.rebuild();
  compare(feed, now + 1000);
  closeFeed(); closeService();
  const restarted = openObservationService({ dbPath });
  t.after(() => restarted.close());
  const restartedFeed = new ProjectionFeed(dbPath, restarted.catchUp);
  t.after(() => restartedFeed.close());
  compare(restartedFeed, now + 2000);
  for (const [index, order] of [[...facts].reverse(), [...facts.slice(3), ...facts.slice(0, 3)]].entries()) {
    const replay = openObservationService({ dbPath: join(directory, `replay-${index}.db`) });
    const replayFeed = new ProjectionFeed(replay.dbPath, replay.catchUp);
    try {
      for (const fact of order) {
        replay.ledger.append(fact);
        replayFeed.refresh(now + 3000 + index);
      }
      compare(replayFeed, now + 4000 + index, replay.dbPath);
    } finally { replayFeed.close(); replay.close(); }
  }
  assert.equal(expected.state_decisions[0].evaluatedAt, undefined);
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

testSocket('attachment.put accepts a large image through the dashboard proxy, replays IDs and blocks managed attachments', async t => {
  const { directory, service, runnerPath } = createFixture(t);
  const api = await startWebSocketServer(service, { port: 0, runnerPath, sessionHosts: { quietMs: 0, warmupMs: 0, attachments: { directory: join(directory, 'attachments') } } });
  t.after(() => api.close());
  const { startStaticServer } = await import('../src/static/index.ts');
  const proxy = await startStaticServer({ port: 0, upstream: api }); t.after(() => proxy.close());
  const client = await connect({ ...api, url: proxy.url, wsUrl: proxy.url.replace('http:', 'ws:') + '/ws' });
  t.after(() => client.socket.terminate());
  const data = Buffer.alloc(2 * 1024 * 1024); Buffer.from([137,80,78,71,13,10,26,10]).copy(data);
  const message = { type: 'cmd', cmd_id: 'upload-once', command: 'attachment.put', payload: { name: 'test.png', mime: 'image/png', dataBase64: data.toString('base64') } };
  client.send(message);
  const first = await client.next('ack'); assert.equal(first.ok, true);
  assert.deepEqual(readFileSync(first.result.path), data);
  client.send(message); assert.deepEqual(await client.next('ack'), first);
  client.send({ type: 'cmd', cmd_id: 'bad-mime', command: 'attachment.put', payload: { ...message.payload, mime: 'image/jpeg' } });
  assert.equal((await client.next('ack')).error, 'Invalid attachment');
  client.send({ type: 'cmd', cmd_id: 'managed-image', command: 'send', payload: { runId: 'r', input: { text: '', attachments: [first.result.attachmentId] } } });
  assert.equal((await client.next('ack')).error, 'managed_attachments_unsupported');
});
