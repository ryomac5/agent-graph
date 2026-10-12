import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocketServer } from "ws";
import { openObservationService } from "../src/service/index.ts";
import { startObservationWorker } from "../src/service/worker-client.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import { acquirePerformanceLock } from "./observe/perf-lock.ts";

const DELIVERY_LIMIT_MS = 200;
const DEADLINE_MS = 10_000;
const SAMPLES = 5;
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = performance.now() + DEADLINE_MS;
  while (!check()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for delivery");
    await delay(5);
  }
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: jsonl の変更から WebSocket 送出までの中央値は 200 ms 以下`, async t => {
    const release = await acquirePerformanceLock();
    t.after(release);
    const home = mkdtempSync(join(tmpdir(), "api-delivery-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const directory = join(home, provider === "claude" ? ".claude/projects/fixture" : ".codex/sessions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, provider === "claude" ? "fixture.jsonl" : "rollout-fixture.jsonl");
    const message = (id: string) => JSON.stringify(provider === "claude"
      ? { type: "assistant", uuid: id, timestamp: new Date().toISOString(), message: { role: "assistant", content: id } }
      : { type: "response_item", timestamp: new Date().toISOString(), payload: { type: "message", id, role: "assistant", content: id } }) + "\n";
    writeFileSync(path, provider === "claude" ? message("initial") : JSON.stringify({ type: "session_meta",
      timestamp: new Date().toISOString(), payload: { id: "fixture", timestamp: new Date().toISOString(), source: "cli", history_mode: "legacy" } }) + "\n" + message("initial"));
    const options = { home, env: { HOME: home }, dbPath: join(home, "ledger.db") };
    const service = openObservationService({ ...options, readerOnly: true });
    t.after(() => service.close());
    // ソケットだけを代用し、監視から実際の送出関数までを通す。
    const server = Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: 12345 }), close: (done: () => void) => done(),
    });
    t.mock.method(http, "createServer", () => server as unknown as http.Server);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    let connect!: (socket: unknown) => void;
    const on = WebSocketServer.prototype.on;
    t.mock.method(WebSocketServer.prototype, "on", function (this: WebSocketServer, event: string, listener: (...args: any[]) => void) {
      if (event === "connection") connect = listener;
      return on.call(this, event, listener);
    });
    const api = await startWebSocketServer(service, { port: 0, runnerPath: join(home, "absent.sock") });
    t.after(() => api.close());
    const worker = await startObservationWorker(service, { ...options, hook: false });
    t.after(() => worker.close());
    worker.start();
    await waitUntil(() => service.getObservation().state === "idle");
    await waitUntil(() => api.feed.snapshot().seq === service.lastSeq());
    const frames: { at: number; frame: any }[] = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1, bufferedAmount: 0,
      send(body: string) { frames.push({ at: performance.now(), frame: JSON.parse(body) }); },
      close() {}, terminate() {},
    });
    connect(socket);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", seq: api.feed.snapshot().seq,
      generation: api.feed.snapshot().generation, scope: { conversations: [JSON.stringify([provider, "fixture"])] } })), false);
    await delay(50);
    const times: number[] = [];
    const initialObservation = service.getObservation();
    let patchSerializations = 0;
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (...args: Parameters<typeof JSON.stringify>) => {
      if (args[0]?.type === "patch") patchSerializations++;
      return stringify(...args);
    });
    for (let i = 0; i < SAMPLES; i++) {
      frames.length = 0;
      patchSerializations = 0;
      const start = performance.now();
      // 短い間隔の追記と途中の行を、同じ変更通知の組として流す。
      const body = message(`reply-${i}`);
      appendFileSync(path, body.slice(0, -1));
      appendFileSync(path, "\n");
      await waitUntil(() => frames.some(({ frame }) => frame.type === "patch" && frame.changes?.messages?.upsert.length));
      if (i === 0) assert.equal(service.getObservation(), initialObservation, "Watch ingestion must preserve observation state and report");
      assert.equal(patchSerializations, frames.filter(({ frame }) => frame.type === "patch").length,
        "Each scoped patch must be serialized only for sending");
      times.push(frames.find(({ frame }) => frame.type === "patch" && frame.changes?.messages?.upsert.length)!.at - start);
      await delay(40);
    }
    const median = times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)];
    t.diagnostic(`change to WebSocket send: median ${median.toFixed(1)} ms; samples ${times.map(ms => ms.toFixed(1)).join(", ")} ms`);
    assert.ok(median <= DELIVERY_LIMIT_MS, `${median.toFixed(1)} ms > ${DELIVERY_LIMIT_MS} ms`);
  });
}

test("観測を無効にした worker も、通知のない台帳追記を投影して配信へ通知する", async t => {
  const { openLedger } = await import("../../core/src/ledger/index.ts");
  const home = mkdtempSync(join(tmpdir(), "api-projection-poll-"));
  const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db"), readerOnly: true });
  const worker = await startObservationWorker(service, { home, env: { HOME: home }, observe: false, hook: false });
  t.after(async () => { await worker.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  let notified = false;
  const unsubscribe = service.onProjection(() => { notified = true; });
  t.after(unsubscribe);
  const writer = openLedger(service.dbPath);
  const result = writer.append({ source: "host-codex", source_event_id: "outside-worker", kind: "conversation.created",
    subject: "conversation:outside", source_ts: new Date().toISOString(), confidence: "confirmed",
    payload: { provider: "codex", native_id: "outside", origin: "managed", type: "interactive", history_format: "legacy" } });
  writer.close();
  await waitUntil(() => notified && service.catchUp().last_seq === result.seq);
  assert.equal(service.projectionSeq(), result.seq);
  assert.equal(service.getObservation().state, "idle");
});

test("連続した変更通知の間も、見回りで新しい会話を取り込む", async t => {
  const home = mkdtempSync(join(tmpdir(), "api-watch-discovery-"));
  const directory = join(home, ".claude/projects/fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "hot.jsonl");
  const row = (id: string) => JSON.stringify({ type: "user", uuid: id, timestamp: new Date().toISOString(),
    message: { role: "user", content: id } }) + "\n";
  writeFileSync(path, row("initial"));
  const options = { home, env: { HOME: home }, dbPath: join(home, "ledger.db") };
  const service = openObservationService({ ...options, readerOnly: true });
  const worker = await startObservationWorker(service, { ...options, hook: false });
  let activity: ReturnType<typeof setInterval> | undefined;
  t.after(async () => { clearInterval(activity); await worker.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  worker.start();
  await waitUntil(() => service.getObservation().state === "idle");
  let index = 0;
  activity = setInterval(() => appendFileSync(path, row(`active-${index++}`)), 50);
  writeFileSync(join(directory, "new.jsonl"), row("new"));
  const start = performance.now();
  await waitUntil(() => service.ledger.readSince(0, 200).some(fact => fact.kind === "conversation.created"
    && fact.payload?.native_id === "new"));
  assert.ok(performance.now() - start < 3000, "Discovery must continue during watch traffic");
  assert.ok(index > 0);
});
