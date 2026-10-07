import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { before, after } from "node:test";
import type { TestContext } from "node:test";
import { migrations } from "../../core/src/store/migrations.ts";
import { migrateLegacyDatabases } from "../src/migrate/index.ts";
import { openObservationService } from "../src/service/index.ts";

import { acquirePerformanceLock } from "./observe/perf-lock.ts";

let releasePerformanceLock: (() => Promise<void>) | undefined;
before(async () => { releasePerformanceLock = await acquirePerformanceLock(); });
after(async () => { await releasePerformanceLock?.(); });

const LEGACY_ROW_COUNT = 20_000;
const DELEGATION_COUNT = 500;
const HISTORY_ROW_COUNT = 50_000;
const PERFORMANCE_LIMIT_MS = 30_000;
const TS = "2026-01-01T00:00:00.000Z";

function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "api-perf-"));
  const dbPath = join(home, "ledger.db");
  const service = openObservationService({ home, dbPath, env: { HOME: home } });
  const database = new DatabaseSync(dbPath);
  t.after(() => { database.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, service, database };
}

function assertProjected(database: DatabaseSync): void {
  const lastSeq = database.prepare("SELECT max(seq) AS seq FROM facts").get()!.seq;
  assert.equal(database.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq, lastSeq);
}

test("2 万 turns・2 万 events・500 委譲の移行を 30 秒以内に反映する", async (t) => {
  const { home, service, database } = createFixture(t);
  const path = join(home, "legacy.db");
  const old = new DatabaseSync(path);
  try {
    for (const migration of migrations) old.exec(migration.sql);
    old.exec("BEGIN");
    old.prepare("INSERT INTO repos VALUES ('perf', ?, 'perf')").run(join(home, "missing-repository"));
    old.prepare("INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at) VALUES ('session', 'perf', 'perf-001', 'claude', 'trace', ?)").run(TS);
    const turn = old.prepare("INSERT INTO turns (id, session_id, at, prompt, reply) VALUES (?, 'session', ?, ?, ?)");
    const event = old.prepare("INSERT INTO events (id, ts, kind, repo_key, session_id, trace_id, span_id, payload) VALUES (?, ?, 'message', 'perf', 'session', 'trace', ?, '{}')");
    for (let index = 0; index < LEGACY_ROW_COUNT; index += 1) {
      turn.run(`turn-${index}`, TS, `Request ${index}`, `Reply ${index}`);
      event.run(`event-${index}`, TS, `span-${index}`);
    }
    const delegation = old.prepare("INSERT INTO delegations (id, repo_key, session_id, role, title, status) VALUES (?, 'perf', 'session', 'implement', 'Performance fixture', 'done')");
    for (let index = 0; index < DELEGATION_COUNT; index += 1) delegation.run(`delegation-${index}`);
    old.exec("COMMIT");
    assert.equal(old.prepare("SELECT count(*) AS count FROM events").get()!.count, LEGACY_ROW_COUNT);
  } finally { old.close(); }
  let projections = 0;
  const options = { batch: service.batch, afterDatabase() {
    projections += 1;
    const projectionStart = performance.now();
    service.catchUp();
    t.diagnostic(`projection: ${(performance.now() - projectionStart).toFixed(1)} ms`);
  } };
  const start = performance.now();
  const report = await migrateLegacyDatabases([path], service.ledger, options);
  const elapsed = performance.now() - start;
  t.diagnostic(`migration including projection: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < PERFORMANCE_LIMIT_MS, `${elapsed.toFixed(1)} ms > ${PERFORMANCE_LIMIT_MS} ms`);
  assert.equal(report.errors.length, 0);
  assert.equal(report.unsupported, 0);
  assert.equal(report.rows.turns, LEGACY_ROW_COUNT);
  assert.equal(report.rows.delegations, DELEGATION_COUNT);
  assert.equal(projections, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM messages").get()!.count, LEGACY_ROW_COUNT * 2);
  assert.equal(database.prepare("SELECT count(*) AS count FROM delegations").get()!.count, DELEGATION_COUNT);
  assertProjected(database);
  const count = database.prepare("SELECT count(*) AS count FROM facts").get()!.count;
  assert.deepEqual(await migrateLegacyDatabases([path], service.ledger, options), report);
  assert.equal(database.prepare("SELECT count(*) AS count FROM facts").get()!.count, count);
  assert.equal(projections, 2);
  assertProjected(database);
});

test("Claude と Codex の計 5 万行を 30 秒以内に取り込み、再走査で事実を増やさない", (t) => {
  const { home, service, database } = createFixture(t);
  const claude = join(home, ".claude", "projects", "fixture");
  const codex = join(home, ".codex", "sessions");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const claudeRows: string[] = [];
  const codexRows = [JSON.stringify({ type: "session_meta", timestamp: TS,
    payload: { id: "codex-perf", timestamp: TS, source: "cli", history_mode: "legacy" } })];
  for (let index = 0; index < HISTORY_ROW_COUNT / 2; index += 1) {
    claudeRows.push(JSON.stringify({ type: "user", uuid: `claude-${index}`, timestamp: TS,
      message: { role: "user", content: `Request ${index}` } }));
    if (index > 0) codexRows.push(JSON.stringify({ type: "response_item", timestamp: TS,
      payload: { type: "message", id: `codex-${index}`, role: "assistant", content: `Reply ${index}` } }));
  }
  writeFileSync(join(claude, "claude-perf.jsonl"), claudeRows.join("\n") + "\n");
  writeFileSync(join(codex, "rollout-perf.jsonl"), codexRows.join("\n") + "\n");
  const start = performance.now();
  const report = service.ingestOnce();
  const elapsed = performance.now() - start;
  t.diagnostic(`50,000 history rows including projection: ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < PERFORMANCE_LIMIT_MS, `${elapsed.toFixed(1)} ms > ${PERFORMANCE_LIMIT_MS} ms`);
  assert.equal(report.unsupported, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM messages").get()!.count, HISTORY_ROW_COUNT - 1);
  assertProjected(database);
  const count = database.prepare("SELECT count(*) AS count FROM facts").get()!.count;
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM facts").get()!.count, count);
  assertProjected(database);
});
