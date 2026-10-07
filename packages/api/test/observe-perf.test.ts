import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs, { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after, type TestContext } from "node:test";
import { WebSocket } from "ws";
import type { Fact, Ledger } from "../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../src/observe/claude/index.ts";
import { observeClaudeContext } from "../src/observe/claude/context.ts";
import { observeCodex, observeCodexLocations } from "../src/observe/codex/index.ts";
import { fileReadMetrics, readAppendOnlyFile } from "../src/observe/files.ts";
import { openBatchLedger } from "../src/service/batch-ledger.ts";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { startObservationWorker } from "../src/service/worker-client.ts";
import { startStaticServer } from "../src/static/index.ts";
import { startWebSocketServer } from "../src/ws/index.ts";

import { acquirePerformanceLock } from "./observe/perf-lock.ts";

let releasePerformanceLock: (() => Promise<void>) | undefined;
before(async () => { releasePerformanceLock = await acquirePerformanceLock(); });
after(async () => { await releasePerformanceLock?.(); });

const CLAUDE_COUNT = 2000;
const CODEX_COUNT = 500;
const IDLE_LIMIT_MS = 50;
const LOOP_LIMIT_MS = 100;
const RESPONSE_LIMIT_MS = 200;
const DEADLINE_MS = 30_000;
const TS = "2026-10-06T10:00:00.000Z";

function createMessage(id: string): string {
  return JSON.stringify({ type: "user", uuid: id, timestamp: TS, message: { role: "user", content: `Request ${id}` } }) + "\n";
}
function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "api-observe-perf-"));
  const cleanups: (() => void | Promise<void>)[] = [];
  const cleanup = (action: () => void | Promise<void>) => cleanups.push(action);
  t.after(async () => {
    for (const action of cleanups.reverse()) await action();
    rmSync(home, { recursive: true, force: true });
  });
  const claude = join(home, ".claude", "projects", "fixture");
  const codex = join(home, ".codex", "sessions", "2026", "10", "06");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(join(home, ".local", "state", "agent-graph", "outbox"), { recursive: true });
  for (let index = 0; index < CLAUDE_COUNT; index += 1) writeFileSync(join(claude, `claude-${index}.jsonl`), createMessage(`claude-${index}`));
  for (let index = 0; index < CODEX_COUNT; index += 1) {
    writeFileSync(join(codex, `rollout-${index}.jsonl`), [
      { type: "session_meta", timestamp: TS, payload: { id: `codex-${index}`, timestamp: TS, source: "cli", history_mode: "legacy" } },
      { type: "response_item", timestamp: TS, payload: { type: "message", id: `codex-message-${index}`, role: "assistant", content: `Reply ${index}` } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const options = { home, env: { HOME: home }, dbPath: join(home, "ledger.db") };
  return { home, claude, codex, options, cleanup };
}
function normalizeFacts(facts: Fact[]): string[] {
  return facts.map(({ source, source_event_id, kind, subject, payload, source_ts, confidence, supersedes }) =>
    JSON.stringify({ source, source_event_id, kind, subject, payload, source_ts, confidence, supersedes })).sort();
}
async function waitUntil(action: () => boolean): Promise<void> {
  const deadline = performance.now() + DEADLINE_MS;
  while (!action()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for observation");
    await delay(10);
  }
}

test("worker の大量取り込み中も主スレッドの遅れは 100 ms 以下で、同期の形式読みと同じ事実になる", async (t) => {
  const f = createFixture(t);
  const service = openObservationService({ ...f.options, readerOnly: true });
  f.cleanup(() => service.close());
  assert.throws(() => service.ledger.append({} as never), /worker/);
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  f.cleanup(() => feed.close());
  const worker = await startObservationWorker(service, { ...f.options, hook: false });
  f.cleanup(() => worker.close());
  let lastTick = performance.now();
  let maximumLag = 0;
  let maximumFeedTime = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maximumLag = Math.max(maximumLag, now - lastTick - 10);
    lastTick = now;
  }, 10);
  t.after(() => clearInterval(timer));
  worker.start();
  worker.start();
  await waitUntil(() => service.getObservation().total === CLAUDE_COUNT + CODEX_COUNT);
  assert.equal(service.getObservation().state, "running");
  feed.refresh();
  assert.equal(feed.snapshot().observation!.state, "running");
  await Promise.race([worker.failure, waitUntil(() => service.getObservation().state === "idle")]);
  const report = service.getObservation().report!;
  await waitUntil(() => {
    const refreshStart = performance.now();
    feed.refresh();
    maximumFeedTime = Math.max(maximumFeedTime, performance.now() - refreshStart);
    return feed.snapshot().seq === report.appended;
  });
  clearInterval(timer);
  t.diagnostic(`maximum event-loop delay: ${maximumLag.toFixed(1)} ms`);
  t.diagnostic(`maximum projection feed refresh: ${maximumFeedTime.toFixed(1)} ms`);
  assert.ok(maximumLag <= LOOP_LIMIT_MS, `${maximumLag.toFixed(1)} ms > ${LOOP_LIMIT_MS} ms`);
  await worker.close();
  await waitUntil(() => service.catchUp().last_seq === report.appended);
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.equal(report.appended, facts.length);
  const reference = openBatchLedger(join(f.home, "reference.db"));
  f.cleanup(() => reference.ledger.close());
  reference.batch(() => {
    // 各合成 Claude ファイルは独立した新規会話なので、既存履歴は空になる。
    const ledger: Ledger = { ...reference.ledger, readSince: () => [] };
    // 形式読みに続けて、会話の場所とターンの根拠の部品も同じ行から読む。
    for (let index = 0; index < CLAUDE_COUNT; index += 1) {
      const path = join(f.claude, `claude-${index}.jsonl`);
      const observation = observeClaudeFile(ledger, path);
      observeClaudeContext(ledger, path, { lines: observation.lines, fromStart: true });
    }
    observeCodex(reference.ledger, { codexHome: join(f.home, ".codex"), batch: reference.batch });
  });
  reference.batch(() => observeCodexLocations(reference.ledger,
    Array.from({ length: CODEX_COUNT }, (_, index) => join(f.codex, `rollout-${index}.jsonl`))));
  assert.deepEqual(normalizeFacts(facts), normalizeFacts(reference.ledger.readSince(0, Number.MAX_SAFE_INTEGER)));
});


test("2000 Claude・500 Codex: 無更新は 50 ms 以下で開かず、追記は一つのファイルの増分だけを読む", (t) => {
  const f = createFixture(t);
  let service = openObservationService(f.options);
  f.cleanup(() => service.close());
  assert.ok(service.ingestOnce().appended > 0);
  let opens = 0;
  let visits = 0;
  const open = fs.openSync;
  const readdir = fs.readdirSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { opens += 1; return open(...args); });
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => { visits += 1; return readdir(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const started = performance.now();
  assert.equal(service.ingestOnce().appended, 0);
  const elapsed = performance.now() - started;
  t.diagnostic(`idle ingestion: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed <= IDLE_LIMIT_MS, `${elapsed.toFixed(1)} ms > ${IDLE_LIMIT_MS} ms`);
  assert.equal(opens, 0);
  assert.equal(visits, 0);
  const tail = createMessage("appended");
  const bytesBefore = fileReadMetrics.contentBytes;
  appendFileSync(join(f.claude, "claude-100.jsonl"), tail);
  assert.equal(service.ingestOnce().appended, 2);
  assert.equal(opens, 1);
  assert.equal(visits, 0);
  assert.equal(fileReadMetrics.contentBytes - bytesBefore, Buffer.byteLength(tail));
  service.close();
  service = openObservationService(f.options);
  opens = 0;
  const resumedBytes = fileReadMetrics.contentBytes;
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(opens, 0);
  assert.equal(fileReadMetrics.contentBytes, resumedBytes);
  const codexTail = JSON.stringify({ type: "response_item", timestamp: TS,
    payload: { type: "message", id: "codex-added", role: "assistant", content: "Additional reply" } }) + "\n";
  appendFileSync(join(f.codex, "rollout-100.jsonl"), codexTail);
  assert.equal(service.ingestOnce().appended, 2);
  assert.equal(opens, 1);
  assert.equal(fileReadMetrics.contentBytes - resumedBytes, Buffer.byteLength(codexTail));
});

test("先頭の指紋・inode・大きさで置換と切り詰めを検出し、未完の行を飛ばさない", (t) => {
  const home = mkdtempSync(join(tmpdir(), "api-observe-reset-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "history.jsonl");
  writeFileSync(path, "first\nsecond\n");
  let cursor = readAppendOnlyFile(path).cursor;
  const contentBytes = fileReadMetrics.contentBytes;
  utimesSync(path, new Date(), new Date(Date.now() + 1000));
  const touched = readAppendOnlyFile(path, cursor);
  assert.equal(touched.reset, false);
  assert.equal(touched.lines.length, 0);
  assert.equal(fileReadMetrics.contentBytes, contentBytes);
  cursor = touched.cursor;
  for (const text of ["other\nsecond\nextra\n", "short\n"]) {
    writeFileSync(path, text);
    const file = readAppendOnlyFile(path, cursor);
    assert.equal(file.reset, true);
    assert.deepEqual(file.lines.map((line) => line.text), text.trim().split("\n"));
    cursor = file.cursor;
  }
  writeFileSync(path + ".new", "short\n");
  renameSync(path + ".new", path);
  const replaced = readAppendOnlyFile(path, cursor);
  assert.equal(replaced.reset, true);
  appendFileSync(path, "partial");
  const incomplete = readAppendOnlyFile(path, replaced.cursor);
  assert.equal(incomplete.pendingBytes, 7);
  appendFileSync(path, "\n");
  assert.deepEqual(readAppendOnlyFile(path, incomplete.cursor).lines.map((line) => line.text), ["partial"]);
});

test("Codex の旧形式メタでも追記だけを読み、新しいディレクトリとファイルを検出する", (t) => {
  const home = mkdtempSync(join(tmpdir(), "api-observe-legacy-"));
  const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db") });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  const directory = join(home, ".codex", "sessions", "nested");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "rollout-legacy.jsonl");
  writeFileSync(path, JSON.stringify({ id: "legacy", timestamp: TS, source: "cli" }) + "\n");
  // 会話と実行に加え、メタに場所がないことを読み終えた印を残す。
  assert.equal(service.ingestOnce().appended, 3);
  let reads = 0;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    reads += 1;
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const tail = JSON.stringify({ type: "response_item", timestamp: TS,
    payload: { type: "message", id: "legacy-added", role: "assistant", content: "Reply" } }) + "\n";
  const bytes = fileReadMetrics.contentBytes;
  appendFileSync(path, tail);
  assert.equal(service.ingestOnce().appended, 2);
  assert.equal(fileReadMetrics.contentBytes - bytes, Buffer.byteLength(tail));
  assert.equal(reads, 0);
  const newDirectory = join(home, ".claude", "projects", "new-project", "nested");
  mkdirSync(newDirectory, { recursive: true });
  writeFileSync(join(newDirectory, "new-session.jsonl"), createMessage("new-message"));
  // 発言と所属と会話に加え、場所の印と会話の記録の実行と最初のターンの根拠を足す。
  assert.equal(service.ingestOnce().appended, 6);
  rmSync(join(newDirectory, "new-session.jsonl"));
  assert.equal(service.ingestOnce().appended, 0);
});

for (const provider of ["claude", "codex"]) {
  for (const stage of ["statSync", "openSync"] as const) {
    test(`${provider}: ${stage} の直前に消えた履歴があっても、他のファイルの増分を取り込む`, (t) => {
      const home = mkdtempSync(join(tmpdir(), "api-observe-removed-"));
      const directory = provider === "claude" ? join(home, ".claude", "projects", "fixture")
        : join(home, ".codex", "sessions");
      mkdirSync(directory, { recursive: true });
      const removed = join(directory, "rollout-removed.jsonl");
      const retained = join(directory, "rollout-retained.jsonl");
      const meta = (id: string) => JSON.stringify({ type: "session_meta", timestamp: TS,
        payload: { id, timestamp: TS, source: "cli", history_mode: "legacy" } }) + "\n";
      writeFileSync(removed, provider === "claude" ? createMessage("removed") : meta("removed"));
      writeFileSync(retained, provider === "claude" ? createMessage("retained") : meta("retained"));
      const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db") });
      t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
      service.ingestOnce();
      const tail = provider === "claude" ? createMessage("retained-added") : JSON.stringify({ type: "response_item",
        timestamp: TS, payload: { type: "message", id: "retained-added", role: "assistant", content: "Reply" } }) + "\n";
      appendFileSync(retained, tail);
      appendFileSync(removed, tail);
      let deleted = false;
      function removeBeforeRead(path: unknown): void {
        if (path === removed && !deleted) {
          deleted = true;
          rmSync(removed);
        }
      }
      if (stage === "statSync") {
        const stat = fs.statSync;
        t.mock.method(fs, stage, (...args: Parameters<typeof fs.statSync>) => { removeBeforeRead(args[0]); return stat(...args); });
      } else {
        const open = fs.openSync;
        t.mock.method(fs, stage, (...args: Parameters<typeof fs.openSync>) => { removeBeforeRead(args[0]); return open(...args); });
      }
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      assert.equal(service.ingestOnce().appended, 2);
      assert.equal(deleted, true);
      assert.equal(service.ingestOnce().appended, 0);
    });
  }
}


test("起動時の worker 取り込み中も静的配信は 200 ms 以内で、snapshot と WebSocket に応答する", async (t) => {
  const f = createFixture(t);
  const service = openObservationService({ ...f.options, readerOnly: true });
  f.cleanup(() => service.close());
  let websocket: Awaited<ReturnType<typeof startWebSocketServer>>;
  try { websocket = await startWebSocketServer(service, { port: 0, runnerPath: join(f.home, "absent.sock") }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") { t.skip("sandbox blocks local HTTP listen"); return; }
    throw error;
  }
  f.cleanup(() => websocket.close());
  const dist = join(f.home, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Observation</title>");
  const dashboard = await startStaticServer({ port: 0, dist, upstream: websocket });
  f.cleanup(() => dashboard.close());
  const worker = await startObservationWorker(service, { ...f.options });
  f.cleanup(() => worker.close());
  worker.start();
  const socket = new WebSocket(`${websocket.wsUrl}?token=${websocket.token}`);
  t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()));
  const pingStart = performance.now();
  socket.ping();
  await pong;
  assert.ok(performance.now() - pingStart <= RESPONSE_LIMIT_MS);
  let probes = 0;
  while (service.catchUp().observation.state === "running") {
    const start = performance.now();
    const response = await fetch(dashboard.url);
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(performance.now() - start <= RESPONSE_LIMIT_MS);
    const snapshot = await fetch(`${websocket.url}/snapshot`, { headers: { "x-agent-graph-token": websocket.token } });
    assert.equal(snapshot.status, 200);
    assert.ok((await snapshot.json()).observation);
    probes += 1;
    await delay(25);
  }
  assert.ok(probes > 0, "Responses must be measured during ingestion");
});

test("ソケットなしでも worker 取り込み中の実際の静的配信ハンドラは 200 ms 以内に応答する", async (t) => {
  const f = createFixture(t);
  const service = openObservationService({ ...f.options, readerOnly: true });
  f.cleanup(() => service.close());
  const feed = new ProjectionFeed(service.dbPath, service.catchUp);
  f.cleanup(() => feed.close());
  const worker = await startObservationWorker(service, { ...f.options, hook: false });
  f.cleanup(() => worker.close());
  const dist = join(f.home, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Observation</title>");
  let handle!: (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;
  const server = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, ready: () => void) => ready(),
    address: () => ({ port: 12345 }), close: (done: () => void) => done(),
  });
  t.mock.method(http, "createServer", (handler: typeof handle) => {
    handle = handler;
    return server as unknown as http.Server;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const dashboard = await startStaticServer({ port: 0, dist, upstream: {
    url: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/ws", token: "fixture", runner: { available: false },
  } });
  f.cleanup(() => dashboard.close());
  worker.start();
  await waitUntil(() => service.getObservation().total === CLAUDE_COUNT + CODEX_COUNT);
  let probes = 0;
  let maximumResponse = 0;
  while (service.getObservation().state === "running") {
    let status = 0;
    let body = "";
    const response = {
      setHeader() {},
      writeHead(code: number) { status = code; return response; },
      end(content: Buffer | string) { body = content.toString(); },
    };
    const start = performance.now();
    await handle({ method: "GET", url: "/", headers: { host: "127.0.0.1:12345" },
      socket: { remoteAddress: "127.0.0.1" } } as http.IncomingMessage, response as unknown as http.ServerResponse);
    maximumResponse = Math.max(maximumResponse, performance.now() - start);
    assert.equal(status, 200);
    assert.match(body, /Observation/);
    feed.refresh();
    assert.ok(feed.snapshot().observation);
    probes += 1;
    await Promise.race([worker.failure, delay(25)]);
  }
  assert.ok(probes > 0);
  assert.ok(maximumResponse <= RESPONSE_LIMIT_MS, `${maximumResponse.toFixed(1)} ms > ${RESPONSE_LIMIT_MS} ms`);
  t.diagnostic(`static handler maximum response: ${maximumResponse.toFixed(1)} ms (${probes} requests)`);
});
