import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test, { before, after } from "node:test";
import type { TestContext } from "node:test";
import { createNativeId, openLedger, project, rebuild, applyIncremental, PROJECTION_SCHEMA_TABLES, PROJECTION_SCHEMA_INDEXES, type FactInput } from "../../core/src/ledger/index.ts";
import { migrations } from "../../core/src/store/migrations.ts";
import { openObservationService } from "../src/service/index.ts";
import { pollObservation } from "../src/service/poll.ts";
import { rebuildInitialProjection } from "../src/service/initial-projection.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { openReadLedger } from "../src/service/read-ledger.ts";

import { acquirePerformanceLock } from "./observe/perf-lock.ts";

let releasePerformanceLock: (() => Promise<void>) | undefined;
before(async () => { releasePerformanceLock = await acquirePerformanceLock(); });
after(async () => { await releasePerformanceLock?.(); });

const TS = "2026-10-06T10:00:00.000Z";
const CLI = new URL("../src/cli.ts", import.meta.url);
const HOOK_EVENT = { version: 1, session_id: "session", generation: 1,
  event_id: "start", hook_event_name: "SessionStart", source_ts: TS, input: {}, managed: false };
const BULK_MESSAGE_COUNT = 1500;
const STAGING_REUSE_MESSAGE_COUNT = 4097;
const BULK_FILE_COUNT = 300;
const MESSAGES_PER_FILE = 10;
const INITIAL_INGEST_LIMIT_MS = 8000;
const IDLE_SCAN_LIMIT_MS = 2000;

for (const sample of ["S17", "S14"]) {
  test(`初回の一括投影は core の再構築と表・検索・索引が一致する (${sample})`, (t) => {
    const f = createFixture(t);
    const service = openObservationService({ env: f.env, writerOnly: true });
    const db = new DatabaseSync(f.dbPath);
    t.after(() => { db.close(); service.close(); });
    const source = sample === "S17" ? new URL("./samples/S17/input.json", import.meta.url)
      : new URL("../../core/test/samples/S14/input.json", import.meta.url);
    const facts = JSON.parse(readFileSync(source, "utf8")) as FactInput[];
    const extras = [
      { kind: "task.created", subject: "task:extra", payload: { name: "Extra", project: "fixture" } },
      { kind: "alias.created", subject: "alias:extra", payload: { entity_id: "task:extra", kind: "kit", name: "fixture-001" } },
      { kind: "conversation.created", subject: "conversation:named", payload: { provider: "claude", native_id: "named", origin: "observed", type: "interactive", history_format: "jsonl" } },
      { kind: "message.created", subject: "message:prompt", payload: { provider: "claude", native_id: "prompt", role: "user", body: [{ text: "First. More" }], body_state: "stored" } },
      { kind: "message_membership.created", subject: "message_membership:prompt", payload: { message_id: "prompt", conversation_id: "named", active: true } },
      { kind: "run.created", subject: "run:duplicate", payload: { conversation_id: "child", generation: 1, state: "unknown" } },
      { kind: "connection.created", subject: "connection:extra", payload: { run_id: "child", type: "mcp", fingerprint: "extra", state: "connected" } },
      { kind: "artifact.created", subject: "artifact:extra", payload: { run_id: "child", version: 1, patch_hash: "fixed", attribution: "unknown" } },
      { kind: "approval.created", subject: "approval:extra", payload: { artifact_id: "extra", patch_hash: "fixed", state: "approved", request: { text: "Review" } } },
      { kind: "finding.created", subject: "finding:extra", payload: { artifact_id: "extra", body: "Finding", state: "open" } },
    ];
    service.batch(() => {
      for (const fact of facts) service.ledger.append(fact);
      for (const extra of extras) service.ledger.append({ ...extra, source: "ui", source_event_id: extra.subject,
        source_ts: TS, confidence: "confirmed" } as FactInput);
      service.ledger.append({ source: "host-codex", source_event_id: "initial-commit", kind: "run.updated", subject: "run:duplicate",
        payload: { git_commit_result: { success: true, sha: "initial" }, review_command: { id: "review-initial" } },
        source_ts: TS, confidence: "confirmed" } as FactInput);
    });
    const readIndexes = () => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name").all();
    const indexes = readIndexes();
    const tables = [...PROJECTION_SCHEMA_TABLES.filter((table) => table !== "projection_state"),
      "search_documents", "search_sources", "search_references", "search_body_sources"];
    const readSchema = () => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    const readTables = () => Object.fromEntries(tables.map((table) => [table,
      db.prepare(`SELECT * FROM ${table}`).all().map((row) => JSON.stringify(row)).sort()]));
    const state = rebuildInitialProjection(db);
    const actual = readTables();
    const schema = readSchema();
    for (const table of PROJECTION_SCHEMA_TABLES) assert.ok(schema.some((entry) => entry.type === "table" && entry.name === table), table);
    for (const index of PROJECTION_SCHEMA_INDEXES) assert.ok(schema.some((entry) => entry.type === "index" && entry.name === index), index);
    assert.deepEqual(readIndexes(), indexes);
    assert.equal(rebuild(db).last_seq, state.last_seq);
    assert.deepEqual(readTables(), actual);
    assert.deepEqual(readIndexes(), indexes);
    assert.deepEqual(readSchema(), schema);
    service.ledger.append({ source: "host-codex", source_event_id: "after-bulk", kind: "run.updated", subject: "run:duplicate",
      payload: { state: "running", git_commit_result: { success: true, sha: "commit" }, review_command: { id: "review-after-bulk" } },
      source_ts: "2026-10-07T10:00:00.000Z", confidence: "confirmed" } as FactInput);
    const updated = applyIncremental(db, state.last_seq);
    const incremental = readTables();
    assert.equal(rebuild(db).last_seq, updated.last_seq);
    assert.deepEqual(readTables(), incremental);
    assert.deepEqual(readSchema(), schema);
  });
}

test("読み取り専用の台帳も core の秘匿規則と事実を返し、書き込みを拒む", (t) => {
  const f = createFixture(t);
  const writer = openLedger(f.dbPath);
  const reader = openReadLedger(f.dbPath);
  t.after(() => { reader.ledger.close(); writer.close(); });
  assert.deepEqual(reader.ledger.getRedactionRules(), writer.getRedactionRules());
  const rules = reader.ledger.getRedactionRules();
  rules.defaults = false;
  assert.deepEqual(reader.ledger.getRedactionRules(), writer.getRedactionRules());
  const input: FactInput = { source: "ui", source_event_id: "read-only", kind: "task.created",
    subject: "task:read-only", payload: { purpose: "Read only", project: "fixture", state: "active" }, source_ts: TS, confidence: "confirmed" };
  writer.append(input);
  assert.deepEqual(reader.ledger.readSince(0, 10), writer.readSince(0, 10));
  assert.throws(() => reader.ledger.append(input), /Ledger writes/);
  assert.throws(() => reader.ledger.purgePayloads(TS), /Ledger writes/);
  assert.throws(() => reader.ledger.prunePayloads(), /Ledger writes/);
  assert.throws(() => reader.batch(() => undefined), /Ledger writes/);
  assert.throws(() => reader.checkpoint(), /Ledger writes/);
});

function createFixture(t: TestContext, useXdg = true) {
  const home = mkdtempSync(join(tmpdir(), "agent-graph-service-"));
  const state = useXdg ? join(home, "state") : join(home, ".local", "state");
  const dbPath = join(state, "agent-graph", "agent-graph.db");
  mkdirSync(join(state, "agent-graph"), { recursive: true });
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: useXdg ? state : undefined,
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  function run(...args: string[]) {
    return JSON.parse(execFileSync(process.execPath, [CLI.pathname, ...args], {
      env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    }));
  }
  function read() {
    const ledger = openLedger(dbPath);
    try { return ledger.readSince(0, Number.MAX_SAFE_INTEGER); } finally { ledger.close(); }
  }
  return { home, state, dbPath, env, run, read };
}
function createClaudeMessage(id: string) {
  return JSON.stringify({ type: "user", uuid: id, timestamp: TS, version: "2.1.291",
    message: { role: "user", content: `Fictional ${id}` } }) + "\n";
}
function createCodexMessage(id: string) {
  return JSON.stringify({ timestamp: TS, type: "response_item", payload: {
    type: "message", id, role: "user", content: [{ type: "input_text", text: `Fictional ${id}` }] } }) + "\n";
}
function readProjection(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  try {
    return { state: db.prepare("SELECT * FROM projection_state").get(),
      messages: db.prepare("SELECT id FROM messages ORDER BY id").all(),
      memberships: db.prepare("SELECT id FROM message_memberships ORDER BY id").all() };
  } finally { db.close(); }
}

test("4500 発言と 301 ファイルをまとめて投影し、空の送信待ちを含む再走査は短時間で終わる", (t) => {
  const f = createFixture(t);
  const directory = join(f.home, ".claude", "projects", "bulk");
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(f.state, "agent-graph", "outbox"));
  writeFileSync(join(directory, "large.jsonl"), Array.from({ length: BULK_MESSAGE_COUNT },
    (_, index) => createClaudeMessage(`large-${index}`)).join(""));
  for (let file = 0; file < BULK_FILE_COUNT; file += 1) {
    writeFileSync(join(directory, `session-${file}.jsonl`), Array.from({ length: MESSAGES_PER_FILE },
      (_, index) => createClaudeMessage(`file-${file}-${index}`)).join(""));
  }
  const messages = BULK_MESSAGE_COUNT + BULK_FILE_COUNT * MESSAGES_PER_FILE;
  let started = performance.now();
  const report = f.run("ingest", "--once");
  const initialMs = performance.now() - started;
  t.diagnostic(`initial ingest: ${initialMs.toFixed(1)} ms`);
  assert.ok(initialMs < INITIAL_INGEST_LIMIT_MS, `initial ingest exceeded ${INITIAL_INGEST_LIMIT_MS} ms`);
  // 各会話は作成に加え、場所と会話の記録の実行と最初のターンの根拠を 1 件ずつ持つ。
  assert.equal(report.appended, messages * 2 + (BULK_FILE_COUNT + 1) * 4);
  const before = f.read();
  const projection = readProjection(f.dbPath);
  assert.equal(projection.messages.length, messages);
  assert.equal(projection.memberships.length, messages);
  assert.equal(projection.state!.last_seq, before.at(-1)!.seq);
  started = performance.now();
  assert.equal(f.run("ingest", "--once").appended, 0);
  const restartMs = performance.now() - started;
  t.diagnostic(`restart ingest: ${restartMs.toFixed(1)} ms`);
  assert.ok(restartMs < IDLE_SCAN_LIMIT_MS, `restart ingest exceeded ${IDLE_SCAN_LIMIT_MS} ms`);
  assert.deepEqual(f.read(), before);
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  for (let scan = 0; scan < 2; scan += 1) {
    started = performance.now();
    assert.equal(service.ingestOnce().appended, 0);
    const idleMs = performance.now() - started;
    t.diagnostic(`idle scan: ${idleMs.toFixed(1)} ms`);
    assert.ok(idleMs < IDLE_SCAN_LIMIT_MS, `idle scan exceeded ${IDLE_SCAN_LIMIT_MS} ms`);
  }
  assert.deepEqual(readProjection(f.dbPath), projection);
  appendFileSync(join(directory, "large.jsonl"), createClaudeMessage("bulk-added"));
  assert.equal(service.ingestOnce().appended, 2);
  assert.equal(readProjection(f.dbPath).messages.length, messages + 1);
  assert.equal(service.ingestOnce().appended, 0);
});

test("一時 HOME の標本を CLI で二度取り込んでも増えず、停止中の新規ファイルと追記を拾う", (t) => {
  const f = createFixture(t);
  cpSync(new URL("samples/S4/projects/", import.meta.url), join(f.home, ".claude", "projects"), { recursive: true });
  const codexDirectory = join(f.home, ".codex", "sessions", "2026", "10", "06");
  cpSync(new URL("samples/S7/", import.meta.url), codexDirectory, { recursive: true });
  cpSync(new URL("samples/S9/", import.meta.url), join(f.home, ".codex", "archived_sessions"), { recursive: true });
  const first = f.run("ingest", "--once");
  assert.ok(first.appended > 0);
  assert.equal(first.unsupported, 1);
  const before = f.read();
  const projection = readProjection(f.dbPath);
  assert.equal(projection.state!.last_seq, before.at(-1)!.seq);
  assert.equal(f.run("ingest", "--once").appended, 0);
  assert.deepEqual(f.read(), before);
  assert.deepEqual(readProjection(f.dbPath), projection);
  const claude = join(f.home, ".claude", "projects", "example", "parent.jsonl");
  appendFileSync(claude, createClaudeMessage("service-added"));
  writeFileSync(join(f.home, ".claude", "projects", "new-session.jsonl"), createClaudeMessage("service-new-session"));
  appendFileSync(join(codexDirectory, "rollout-exec.jsonl"), createCodexMessage("service-codex-added"));
  const next = f.run("ingest", "--once");
  // 新しい会話は、場所と会話の記録の実行と最初のターンの根拠も持つ。
  assert.equal(next.appended, 10);
  assert.equal(next.unsupported, 0);
  assert.equal(f.run("ingest", "--once").appended, 0);
  const facts = f.read();
  assert.deepEqual(facts.slice(0, before.length), before);
  assert.ok(facts.some((fact) => fact.cursor && JSON.parse(fact.cursor).offset > 0));
  const view = project(facts);
  assert.equal(view.tasks.length, 0);
  assert.ok(view.conversations.every((conversation) => !conversation.task_id));
  assert.equal(readProjection(f.dbPath).messages.length, view.messages.length);
  const rebuilt = f.run("rebuild");
  assert.equal(rebuilt.last_seq, facts.at(-1)!.seq);
  assert.deepEqual(readProjection(f.dbPath).messages.map((row) => String(row.id)), projection.messages.concat(
    ["service-added", "service-new-session"].map((id) => ({ id: createNativeId("claude", id) })),
    [{ id: createNativeId("codex", "service-codex-added") }]).map((row) => String(row.id)).sort());
});

test("再起動は台帳の cursor を使い、未完行を保留し、Codex の古い中間行を再送しない", (t) => {
  const f = createFixture(t);
  const directory = join(f.home, ".codex", "sessions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "rollout-cursor.jsonl");
  writeFileSync(path, JSON.stringify({ type: "session_meta", timestamp: TS,
    payload: { id: "cursor", timestamp: TS, source: "cli", history_mode: "legacy" } }) + "\n"
    + ["first", "middle", "last"].map(createCodexMessage).join(""));
  f.run("ingest", "--once");
  const before = f.read();
  const next = createCodexMessage("after-restart");
  appendFileSync(path, next.slice(0, 40));
  assert.equal(f.run("ingest", "--once").appended, 0);
  appendFileSync(path, next.slice(40));
  const service = openObservationService({ home: f.home, env: f.env });
  t.after(() => service.close());
  const append = service.ledger.append;
  const seen: string[] = [];
  service.ledger.append = (input) => { seen.push(input.source_event_id); return append(input); };
  assert.equal(service.ingestOnce().appended, 2);
  assert.ok(!seen.includes("message:middle:1"));
  assert.equal(service.ingestOnce().appended, 0);
  assert.deepEqual(service.ledger.readSince(0, before.length), before);
  const archived = join(f.home, ".codex", "archived_sessions");
  mkdirSync(archived);
  renameSync(path, join(archived, "rollout-cursor.jsonl"));
  assert.equal(service.ingestOnce().appended, 1);
  renameSync(join(archived, "rollout-cursor.jsonl"), path);
  assert.equal(service.ingestOnce().appended, 1);
  assert.equal(service.ingestOnce().appended, 0);
});

test("登録されたプロジェクトの別名と hook 送信待ちを取り込み、外部追記の投影も補う", (t) => {
  const f = createFixture(t);
  const root = join(f.home, "repository");
  const state = join(root, ".agents", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "sessions.json"), JSON.stringify({ "session": "example-001" }));
  writeFileSync(join(state, "counter"), "999");
  const ledger = openLedger(f.dbPath);
  ledger.append({ source: "ui", source_event_id: "project", kind: "project.created", subject: "project:registered",
    payload: { repository_id: "registered", root_path: root, display_name: "Example", name_prefix: "example", state: "registered" },
    source_ts: TS, confidence: "confirmed" });
  ledger.close();
  const outbox = join(f.state, "agent-graph", "outbox");
  mkdirSync(outbox, { recursive: true });
  writeFileSync(join(outbox, "event.json"), JSON.stringify({ version: 1, session_id: "session", generation: 1,
    event_id: "start", hook_event_name: "SessionStart", source_ts: TS, input: {}, managed: false }));
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  assert.equal(service.ingestOnce().appended, 3);
  const kitFacts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.source === "kit");
  assert.deepEqual(kitFacts.map(fact => fact.kind), ["alias.created"]);
  assert.equal(project(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)).conversations[0].kit_name, "example-001");
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(readFileSync(join(state, "counter"), "utf8"), "999");
  const external = openLedger(f.dbPath);
  external.append({ source: "hook", source_event_id: "external", kind: "run.state_changed", subject: "run:claude:session:1",
    payload: { generation: 1, state: "running" }, source_ts: "2026-10-06T11:00:00.000Z", confidence: "confirmed" });
  external.close();
  const stateAfter = service.catchUp();
  assert.equal(stateAfter.last_seq, 5);
});

test("同じ取り込みで届いたキットの別名を委譲の親の照合に使う", (t) => {
  const f = createFixture(t);
  const root = join(f.home, "repository");
  const state = join(root, ".agents", "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "sessions.json"), JSON.stringify({ session: "example-001" }));
  writeFileSync(join(state, "events.jsonl"), JSON.stringify({ ts: TS, event: "codex_start",
    session: "example-001", node_id: "child", description: "Fixture task" }) + "\n");
  const ledger = openLedger(f.dbPath);
  ledger.append({ source: "ui", source_event_id: "project", kind: "project.created", subject: "project:registered",
    payload: { repository_id: "registered", root_path: root, display_name: "Example", name_prefix: "example", state: "registered" },
    source_ts: TS, confidence: "confirmed" });
  ledger.close();
  const outbox = join(f.state, "agent-graph", "outbox");
  mkdirSync(outbox);
  writeFileSync(join(outbox, "event.json"), JSON.stringify(HOOK_EVENT));
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  service.ingestOnce();
  const parent = service.ledger.readSince(0, 100).find((fact) => fact.kind === "relation.created")!;
  assert.equal(parent.payload!.from_id, createNativeId("claude", "session"));
  assert.equal(parent.confidence, "inferred");
  assert.equal(service.ingestOnce().appended, 0);
});

test("migrate は場所以下の全旧 DB を変換し、二度の実行で台帳と元 DB を保つ", (t) => {
  const f = createFixture(t);
  const old = join(f.home, "legacy");
  for (const id of ["first", "second"]) {
    const directory = join(old, id);
    mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(join(directory, "agent-graph.db"));
    db.exec(migrations[0].sql);
    db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run(id, directory, id);
    db.prepare("INSERT INTO sessions VALUES ('session', ?, ?, 'claude', 'trace', ?)").run(id, `${id}-001`, TS);
    db.close();
  }
  const original = readFileSync(join(old, "first", "agent-graph.db"));
  const report = f.run("migrate", "--from", old);
  assert.equal(report.databases, 2);
  assert.equal(report.rows.sessions, 2);
  const facts = f.read();
  assert.deepEqual(f.run("migrate", "--from", old), report);
  assert.deepEqual(f.read(), facts);
  assert.deepEqual(readFileSync(join(old, "first", "agent-graph.db")), original);
  assert.equal(readProjection(f.dbPath).state!.last_seq, facts.at(-1)!.seq);
});

for (const useXdg of [false, true]) {
  test(`migrate は旧 DB と台帳が同居する ${useXdg ? "XDG" : "既定 HOME"} の状態ディレクトリで二度実行できる`, (t) => {
    const f = createFixture(t, useXdg);
    const stateDirectory = join(f.state, "agent-graph");
    const originals = ["first", "second"].map((id) => {
      const directory = join(stateDirectory, id);
      mkdirSync(directory);
      const path = join(directory, "agent-graph.db");
      const db = new DatabaseSync(path);
      db.exec(migrations[0].sql);
      db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run(id, directory, id);
      db.prepare("INSERT INTO sessions VALUES ('session', ?, ?, 'claude', 'trace', ?)").run(id, `${id}-001`, TS);
      db.close();
      return { path, contents: readFileSync(path) };
    });
    // バックアップと送信待ちは旧 DB として開かない。
    for (const name of [".migration-backups", "migration-backups", "agent-graph.db.migration-backups", "outbox"]) {
      const directory = join(stateDirectory, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "ignored.db"), "Not a legacy database");
    }
    const report = f.run("migrate", "--from", stateDirectory);
    assert.equal(report.databases, 2);
    assert.equal(report.rows.repos, 2);
    assert.equal(report.rows.sessions, 2);
    const facts = f.read();
    const projection = readProjection(f.dbPath);
    const ledgerContents = readFileSync(f.dbPath);
    assert.ok(facts.length > 0);
    assert.equal(projection.state!.last_seq, facts.at(-1)!.seq);
    assert.deepEqual(f.run("migrate", "--from", stateDirectory), report);
    assert.deepEqual(f.read(), facts);
    assert.deepEqual(readProjection(f.dbPath), projection);
    assert.deepEqual(readFileSync(f.dbPath), ledgerContents);
    for (const original of originals) assert.deepEqual(readFileSync(original.path), original.contents);
  });
}

test("停止中の外部追記を起動時に投影し、表を持たない事実の後も発言を反映する", (t) => {
  const f = createFixture(t);
  const service = openObservationService({ env: f.env });
  service.close();
  const external = openLedger(f.dbPath);
  external.append({ source: "ui", source_event_id: "project-only", kind: "project.created", subject: "project:example",
    payload: { repository_id: "example", root_path: join(f.home, "repository"), display_name: "Example",
      name_prefix: "example", state: "registered" }, source_ts: TS, confidence: "confirmed" });
  external.close();
  const restarted = openObservationService({ env: f.env });
  t.after(() => restarted.close());
  assert.equal(readProjection(f.dbPath).state!.last_seq, 1);
  const writer = openLedger(f.dbPath);
  writer.append({ source: "ui", source_event_id: "message-after-project", kind: "message.created", subject: "message:external",
    payload: { provider: "claude", native_id: "external", version: 1, role: "user", body: "Fictional external message",
      body_state: "stored" }, source_ts: TS, confidence: "confirmed" });
  writer.close();
  assert.equal(restarted.catchUp().last_seq, 2);
  assert.deepEqual(readProjection(f.dbPath).messages.map((row) => row.id), [createNativeId("claude", "external")]);
  const before = readProjection(f.dbPath);
  assert.equal(restarted.catchUp().last_seq, 2);
  assert.deepEqual(readProjection(f.dbPath), before);
  restarted.rebuild();
  assert.deepEqual(readProjection(f.dbPath).messages, before.messages);
});

test("履歴がなくても ingest は終了し、--db の指定が状態の既定より優先する", (t) => {
  const f = createFixture(t);
  const dbPath = join(f.home, "custom", "ledger.db");
  assert.equal(f.run("ingest", "--once", "--db", dbPath).appended, 0);
  assert.equal(readProjection(dbPath).state!.last_seq, 0);
  assert.throws(() => f.run("ingest"), /requires --once/);
});

test("Codex の所属の追記前に停止しても cursor の再読で補い、置換された履歴も取り込む", (t) => {
  const f = createFixture(t);
  const directory = join(f.home, ".codex", "sessions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "rollout-interrupted.jsonl");
  const meta = JSON.stringify({ type: "session_meta", timestamp: TS,
    payload: { id: "interrupted", timestamp: TS, source: "cli", history_mode: "legacy" } }) + "\n";
  writeFileSync(path, meta + ["first", "middle", "last"].map(createCodexMessage).join(""));
  f.run("ingest", "--once");
  appendFileSync(path, createCodexMessage("interrupted"));
  const service = openObservationService({ env: f.env });
  const append = service.ledger.append;
  service.ledger.append = (input) => {
    if (input.kind === "message_membership.created" && input.payload.message_id === createNativeId("codex", "interrupted")) {
      throw new Error("Interrupted membership append");
    }
    return append(input);
  };
  try { assert.throws(() => service.ingestOnce(), /Interrupted membership/); } finally { service.close(); }
  assert.equal(f.run("ingest", "--once").appended, 1);
  assert.equal(project(f.read()).message_memberships.length, 4);
  // 同じ inode の同じ長さの変更も、位置だけでなくハッシュで検出する。
  writeFileSync(path, meta + ["first", "change", "last", "interrupted"].map(createCodexMessage).join(""));
  assert.equal(f.run("ingest", "--once").appended, 2);
  assert.ok(project(f.read()).messages.some((message) => message.native_id === "change"));
  assert.equal(f.run("ingest", "--once").appended, 0);
});

test("不正な送信待ちは未対応として一度だけ記録し、後続を取り込んで修復後に再読する", (t) => {
  const f = createFixture(t);
  const outbox = join(f.state, "agent-graph", "outbox");
  mkdirSync(outbox);
  const invalid = ["{secret-content", JSON.stringify({ ...HOOK_EVENT, generation: 0 })];
  invalid.forEach((body, index) => writeFileSync(join(outbox, `${index}.json`), body));
  writeFileSync(join(outbox, "valid.json"), JSON.stringify(HOOK_EVENT));
  assert.deepEqual(f.run("ingest", "--once"), { appended: 4, unsupported: 2, pending: 0, deferred: 0 });
  const before = f.read();
  assert.equal(JSON.stringify(before).includes("secret-content"), false);
  assert.equal(f.run("ingest", "--once").appended, 0);
  assert.deepEqual(f.read(), before);
  invalid.forEach((body, index) => assert.equal(readFileSync(join(outbox, `${index}.json`), "utf8"), body));
  writeFileSync(join(outbox, "0.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "repaired", hook_event_name: "Stop" }));
  assert.equal(f.run("ingest", "--once").appended, 1);
  assert.equal(f.run("ingest", "--once").appended, 0);
});

for (const phase of ["read", "unlink"] as const) {
  test(`送信待ちが ${phase} の直前に他の送信者から消されても後続を取り込む`, (t) => {
    const f = createFixture(t);
    const service = openObservationService({ env: f.env });
    t.after(() => service.close());
    mkdirSync(service.outbox);
    const path = join(service.outbox, "first.json");
    writeFileSync(path, JSON.stringify(HOOK_EVENT));
    writeFileSync(join(service.outbox, "second.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "second" }));
    const method = phase === "read" ? "readFileSync" : "unlinkSync";
    const original = fs[method];
    let raced = false;
    t.mock.method(fs, method, (...args: unknown[]) => {
      if (args[0] === path && !raced) {
        raced = true;
        rmSync(path);
      }
      return Reflect.apply(original, fs, args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    assert.equal(service.ingestOnce().appended, phase === "read" ? 2 : 3);
    assert.equal(raced, true);
    assert.equal(service.ingestOnce().appended, 0);
    assert.ok(f.read().some((fact) => fact.source_event_id.includes("second")));
  });
}

test("常駐の走査は SQLITE_BUSY と一時失敗を記録し、次回に進み、破損は終了へ伝える", (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  let attempts = 0;
  const action = () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("SQLITE_BUSY"), { errcode: 5 });
    if (attempts === 2) throw new Error("Temporary read failure");
    return "recovered";
  };
  assert.equal(pollObservation(action), undefined);
  assert.equal(pollObservation(action), undefined);
  assert.equal(pollObservation(action), "recovered");
  assert.deepEqual(errors, ["Observation failed: SQLITE_BUSY", "Observation failed: Temporary read failure"]);
  for (const errcode of [11, 21, 26]) {
    assert.throws(() => pollObservation(() => { throw Object.assign(new Error("Fatal database error"), { errcode }); }),
      /Fatal database error/);
  }
});

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for serve");
    await delay(25);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`serve は起動と定期走査の失敗後も回復し、hook を受理して ${signal} で停止する`, async (t) => {
    const f = createFixture(t);
    const outbox = join(f.state, "agent-graph", "outbox");
    mkdirSync(outbox);
    const conflict = join(outbox, "conflict.json");
    writeFileSync(conflict, JSON.stringify(HOOK_EVENT));
    f.run("ingest", "--once");
    writeFileSync(conflict, JSON.stringify({ ...HOOK_EVENT, input: { changed: true } }));
    writeFileSync(join(outbox, "00-invalid.json"), "{");
    const child = spawn(process.execPath, [CLI.pathname, "serve"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
    await waitUntil(() => stdout.includes("hook_url") || child.exitCode !== null);
    if (!stdout.includes("hook_url") && /EPERM/.test(stderr)) {
      t.skip("sandbox blocks local HTTP listen");
      return;
    }
    assert.ok(stdout.includes("hook_url"), stderr);
    const ready = JSON.parse(stdout.trim());
    await waitUntil(() => stderr.includes("Conflicting hook event"));
    assert.equal(child.exitCode, null);
    rmSync(conflict);
    writeFileSync(join(outbox, "recovered.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "recovered", hook_event_name: "Stop" }));
    await waitUntil(() => f.read().some((fact) => fact.source_event_id.includes("recovered")));
    const endpoint = JSON.parse(readFileSync(ready.hook_endpoint_file, "utf8"));
    const response = await fetch(endpoint.url, { method: "POST", headers: {
      "content-type": "application/json", authorization: `Bearer ${endpoint.token}`,
    }, body: JSON.stringify({ ...HOOK_EVENT, event_id: "http", hook_event_name: "UserPromptSubmit" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).accepted, true);
    writeFileSync(conflict, JSON.stringify({ ...HOOK_EVENT, input: { changed: true } }));
    await waitUntil(() => (stderr.match(/Conflicting hook event/g) ?? []).length >= 2);
    assert.equal(child.exitCode, null);
    rmSync(conflict);
    writeFileSync(join(outbox, "later.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "later", hook_event_name: "Stop" }));
    await waitUntil(() => f.read().some((fact) => fact.source_event_id.includes("later")));
    const facts = f.read();
    assert.equal(facts.filter((fact) => fact.kind === "observation.unsupported").length, 1);
    await waitUntil(() => readProjection(f.dbPath).state!.last_seq === facts.at(-1)!.seq);
    assert.equal(readProjection(f.dbPath).state!.last_seq, facts.at(-1)!.seq);
    child.kill(signal);
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(ready.hook_endpoint_file), false);
    await assert.rejects(fetch(endpoint.url));
  });
}

test("worker は初回の取り込み失敗後も再試行し、回復した事実を通知して停止する", async (t) => {
  const f = createFixture(t);
  const outbox = join(f.state, "agent-graph", "outbox");
  mkdirSync(outbox);
  const conflict = join(outbox, "conflict.json");
  writeFileSync(conflict, JSON.stringify(HOOK_EVENT));
  f.run("ingest", "--once");
  writeFileSync(conflict, JSON.stringify({ ...HOOK_EVENT, input: { changed: true } }));
  const service = openObservationService({ env: f.env, readerOnly: true });
  const { startObservationWorker } = await import("../src/service/worker-client.ts");
  const worker = await startObservationWorker(service, { env: f.env, hook: false });
  t.after(async () => { await worker.close(); service.close(); });
  worker.start();
  await waitUntil(() => service.getObservation().state === "failed");
  rmSync(conflict);
  writeFileSync(join(outbox, "recovered.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "recovered", hook_event_name: "Stop" }));
  await waitUntil(() => service.getObservation().state === "idle");
  assert.ok(service.ledger.readSince(0, 100).some((fact) => fact.source_event_id.includes("recovered")));
  assert.equal(service.getObservation().report!.appended, 1);
  await worker.close();
});

test("hook は応答前に追記を確定し、投影を後続の周期まで保留する", async (t) => {
  const f = createFixture(t);
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  const { createHookHandler } = await import("../src/hook/index.ts");
  const { Readable } = await import("node:stream");
  const request = Object.assign(Readable.from([JSON.stringify(HOOK_EVENT)]), {
    method: "POST", url: "/hook-v2",
    headers: { host: "127.0.0.1:12345", authorization: "Bearer token", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1", localPort: 12345 },
  });
  let status = 0;
  let accepted = false;
  const response = {
    writeHead(code: number) { status = code; },
    end(body: string) {
      accepted = JSON.parse(body).accepted;
      const reader = new DatabaseSync(f.dbPath);
      try {
        assert.equal(reader.prepare("SELECT count(*) AS count FROM facts").get()!.count, 2);
        assert.equal(reader.prepare("SELECT last_seq FROM projection_state").get()!.last_seq, 0);
      } finally { reader.close(); }
    },
  };
  await createHookHandler(service.ledger, "token")(
    request as unknown as http.IncomingMessage, response as unknown as http.ServerResponse,
  );
  assert.equal(status, 200);
  assert.equal(accepted, true);
  assert.equal(service.catchUp().last_seq, 2);
});

for (const live of [false, true]) {
  test(`取り込みの投影は ${live ? "常駐でも一回の走査の終了時" : "一回の走査の終了時"} にまとめる`, (t) => {
    const f = createFixture(t);
    let clock = 0;
    t.mock.method(performance, "now", () => clock);
    const service = openObservationService({ env: f.env, live });
    t.after(() => service.close());
    const directory = join(f.home, ".claude", "projects");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "batch.jsonl"), ["one", "two", "three"].map(createClaudeMessage).join(""));
    const reader = new DatabaseSync(f.dbPath);
    t.after(() => reader.close());
    const append = service.ledger.append;
    const positions: number[] = [];
    service.ledger.append = (input) => {
      clock += 250;
      const result = append(input);
      positions.push(Number(reader.prepare("SELECT last_seq FROM projection_state").get()!.last_seq));
      return result;
    };
    // 3 件の発言と所属、会話、場所、会話の記録の実行、最初のターンの根拠を 1 回の走査で追記する。
    assert.equal(service.ingestOnce().appended, 10);
    assert.deepEqual(positions, Array(10).fill(0));
    assert.equal(reader.prepare("SELECT last_seq FROM projection_state").get()!.last_seq, 10);
    assert.equal(service.ingestOnce().appended, 0);
  });
}

test("一括追記も core と同じ秘匿・識別・衝突・差分投影の依存を保存する", async (t) => {
  const f = createFixture(t);
  const { openBatchLedger } = await import("../src/service/batch-ledger.ts");
  const buffered = openBatchLedger(f.dbPath);
  const referencePath = join(f.home, "reference.db");
  const reference = openLedger(referencePath);
  const actualDb = new DatabaseSync(f.dbPath);
  const referenceDb = new DatabaseSync(referencePath);
  t.after(() => { actualDb.close(); referenceDb.close(); buffered.ledger.close(); reference.close(); });
  const input = { source: "hook" as const, source_event_id: "batch-message", kind: "message.created" as const,
    subject: "message:batch" as const, source_ts: TS, observed_ts: TS, confidence: "confirmed" as const,
    payload: { provider: "claude" as const, native_id: "batch", version: 1, role: "user",
      body: "sk-ant-abcdefghijklmnopqrstuvwxyz123456", body_state: "stored" as const } };
  const changed = { ...input, payload: { ...input.payload, body: "Changed body" } };
  buffered.batch(() => {
    for (const fact of [input, changed, input, changed]) {
      assert.deepEqual(buffered.ledger.append(fact), reference.append(fact));
    }
  });
  assert.deepEqual(buffered.ledger.readSince(0, 100), reference.readSince(0, 100));
  const dependencySql = "SELECT * FROM fact_projection_dependencies ORDER BY projection, subject, direction, key, seq";
  assert.deepEqual(actualDb.prepare(dependencySql).all(), referenceDb.prepare(dependencySql).all());
  assert.deepEqual(buffered.ledger.append(input), reference.append(input));
  assert.deepEqual(buffered.ledger.append(changed), reference.append(changed));
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  assert.equal(service.catchUp().last_seq, 1);
  assert.equal(readProjection(f.dbPath).messages.length, 1);
});

test("一括追記の依存保存が失敗しても、その事実だけを戻し成功済みの追記を保持する", async (t) => {
  const f = createFixture(t);
  const { openBatchLedger } = await import("../src/service/batch-ledger.ts");
  const buffered = openBatchLedger(f.dbPath);
  const db = new DatabaseSync(f.dbPath);
  t.after(() => { db.close(); buffered.ledger.close(); });
  db.exec(`CREATE TRIGGER fail_dependency BEFORE INSERT ON fact_projection_dependencies
    WHEN NEW.subject = 'message:failed' BEGIN SELECT RAISE(ABORT, 'Injected dependency failure'); END`);
  const input = { source: "hook" as const, source_event_id: "batch-success", kind: "message.created" as const,
    subject: "message:success" as const, source_ts: TS, confidence: "confirmed" as const,
    payload: { provider: "claude" as const, native_id: "success", version: 1, role: "user",
      body: "Request", body_state: "stored" as const } };
  const failed = { ...input, source_event_id: "batch-failed", subject: "message:failed" as const,
    payload: { ...input.payload, native_id: "failed" } };
  assert.throws(() => buffered.batch(() => {
    buffered.ledger.append(input);
    buffered.ledger.append(failed);
  }), /Injected dependency failure/);
  assert.equal(buffered.ledger.readSince(0, 100).length, 1);
  db.exec("DROP TRIGGER fail_dependency");
  assert.equal(buffered.ledger.append(failed).status, "appended");
  assert.equal(buffered.ledger.readSince(0, 100).length, 2);
});

test("束ねの途中の readSince は未保存の事実を読み、保存も投影も起こさない", async (t) => {
  const f = createFixture(t);
  const { openBatchLedger } = await import("../src/service/batch-ledger.ts");
  const buffered = openBatchLedger(f.dbPath);
  const db = new DatabaseSync(f.dbPath);
  t.after(() => { db.close(); buffered.ledger.close(); });
  const input = { source: "hook" as const, source_event_id: "buffered", kind: "message.created" as const,
    subject: "message:buffered" as const, source_ts: TS, confidence: "confirmed" as const,
    payload: { provider: "claude" as const, native_id: "buffered", version: 1, role: "user", body: "Request", body_state: "stored" as const } };
  buffered.batch(() => {
    const first = buffered.ledger.append(input);
    assert.deepEqual(buffered.ledger.readSince(0, 1).map((fact) => fact.seq), [first.seq]);
    const second = buffered.ledger.append({ ...input, source_event_id: "next", subject: "message:next" });
    assert.deepEqual(buffered.ledger.readSince(first.seq, 1).map((fact) => fact.seq), [second.seq]);
    assert.equal(buffered.ledger.append(input).status, "duplicate");
    assert.equal(db.prepare("SELECT count(*) AS count FROM facts").get()!.count, 0);
    assert.equal(db.prepare("SELECT last_seq FROM projection_state").get()!.last_seq, 0);
  });
  assert.equal(db.prepare("SELECT count(*) AS count FROM facts").get()!.count, 2);
});

test("準備台帳の再利用後も所属・訂正の依存と再送の結果が core と一致する", async (t) => {
  const f = createFixture(t);
  const { openBatchLedger } = await import("../src/service/batch-ledger.ts");
  const buffered = openBatchLedger(f.dbPath);
  const referencePath = join(f.home, "reference.db");
  const reference = openLedger(referencePath);
  const actualDb = new DatabaseSync(f.dbPath);
  const referenceDb = new DatabaseSync(referencePath);
  t.after(() => { actualDb.close(); referenceDb.close(); buffered.ledger.close(); reference.close(); });
  const input = { source: "hook" as const, source_event_id: "first", kind: "message.created" as const,
    subject: "message:first" as const, source_ts: TS, observed_ts: TS, confidence: "confirmed" as const,
    payload: { provider: "claude" as const, native_id: "first", version: 1, role: "user",
      body: "Request", body_state: "stored" as const } };
  buffered.batch(() => {
    const first = buffered.ledger.append(input);
    assert.deepEqual(first, reference.append(input));
    // 準備台帳の掃除をまたぎ、耐久台帳と準備台帳の seq をずらす。
    for (let index = 0; index < STAGING_REUSE_MESSAGE_COUNT; index += 1) {
      const next = { ...input, source_event_id: `next-${index}`, subject: `message:next-${index}` as const,
        payload: { ...input.payload, native_id: `next-${index}` } };
      assert.deepEqual(buffered.ledger.append(next), reference.append(next));
    }
    const membership = { ...input, source_event_id: "membership", kind: "message_membership.created" as const,
      subject: "message_membership:first" as const,
      payload: { message_id: createNativeId("claude", "first"), conversation_id: createNativeId("claude", "session"), active: true } };
    const correction = { ...input, source_event_id: "correction", kind: "message.corrected" as const,
      subject: "message:corrected" as const, supersedes: first.fact_id };
    for (const next of [membership, correction, input, { ...input, payload: { ...input.payload, body: "Changed" } }]) {
      assert.deepEqual(buffered.ledger.append(next), reference.append(next));
    }
  });
  assert.deepEqual(buffered.ledger.readSince(0, Number.MAX_SAFE_INTEGER), reference.readSince(0, Number.MAX_SAFE_INTEGER));
  const sql = "SELECT * FROM fact_projection_dependencies ORDER BY projection, subject, direction, key, seq";
  assert.deepEqual(actualDb.prepare(sql).all(), referenceDb.prepare(sql).all());
});

test("バッチの再接続と中断をまたいで準備中の追記と重複を読める", async t => {
  const f = createFixture(t);
  const { openBatchLedger } = await import("../src/service/batch-ledger.ts");
  const buffered = openBatchLedger(f.dbPath);
  t.after(() => buffered.ledger.close());
  const first = { source: "ui", source_event_id: "first", kind: "task.created", subject: "task:first",
    source_ts: TS, observed_ts: TS, confidence: "confirmed", payload: { name: "First", purpose: "", project: "fixture", state: "open" } } as const satisfies FactInput;
  const second = { ...first, source_event_id: "second", subject: "task:second", payload: { ...first.payload, name: "Second" } } as const satisfies FactInput;
  buffered.batch(() => {
    buffered.ledger.append(first);
    assert.deepEqual(buffered.ledger.readSince(0, 10).map(fact => fact.subject), [first.subject]);
  });
  assert.throws(() => buffered.batch(() => {
    buffered.ledger.append(second);
    assert.deepEqual(buffered.ledger.readSince(0, 10).map(fact => fact.subject), [first.subject, second.subject]);
    throw new Error("Interrupted observation");
  }), /Interrupted observation/);
  const stored = buffered.ledger.readSince(0, 10);
  buffered.batch(() => {
    assert.equal(buffered.ledger.append(first).status, "duplicate");
    assert.equal(buffered.ledger.append({ ...second, payload: { ...second.payload, name: "Changed" } }).status, "conflict");
    assert.deepEqual(buffered.ledger.readSince(stored[0].seq, 1), [stored[1]]);
  });
  assert.deepEqual(buffered.ledger.readSince(0, 10), stored);
});

test("既存の Claude の子の親を補い、根の snapshot にキットの系列を載せる", (t) => {
  const f = createFixture(t);
  const root = join(f.home, "repository");
  const kitState = join(root, ".agents", "state");
  const histories = join(f.env.CLAUDE_CONFIG_DIR, "projects", "repo");
  const children = join(histories, "first", "subagents");
  mkdirSync(kitState, { recursive: true });
  mkdirSync(children, { recursive: true });
  writeFileSync(join(histories, "first.jsonl"), createClaudeMessage("first"));
  writeFileSync(join(histories, "second.jsonl"), createClaudeMessage("second"));
  writeFileSync(join(children, "agent-child.jsonl"), createClaudeMessage("child"));
  writeFileSync(join(children, "agent-child.meta.json"), JSON.stringify({ toolUseId: "tool", description: "Inspect implementation", agentType: "Explore" }));
  const existing = openLedger(f.dbPath);
  existing.append({ source: "legacy", source_event_id: "existing-child", kind: "conversation.created",
    subject: `conversation:${createNativeId("claude", "agent-child")}`, source_ts: TS, confidence: "confirmed",
    payload: { provider: "claude", native_id: "agent-child", origin: "observed", type: "subagent", history_format: "jsonl" } });
  existing.close();
  const service = openObservationService({ env: f.env });
  t.after(() => service.close());
  service.ingestOnce();
  service.ledger.append({ source: "ui", source_event_id: "registered-root", kind: "project.created", subject: "project:registered",
    payload: { repository_id: "registered", root_path: root, display_name: "Example", name_prefix: "example", state: "registered" },
    source_ts: TS, confidence: "confirmed" });
  writeFileSync(join(kitState, "sessions.json"), JSON.stringify({ first: "agent-graph-001", second: "agent-graph-001" }));
  service.ingestOnce();
  const projected = project(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER));
  const relation = projected.relations.find(row => row.type === "delegated")!;
  assert.equal(relation.from_id, createNativeId("claude", "first"));
  assert.equal(relation.to_id, createNativeId("claude", "agent-child"));
  assert.deepEqual(relation.evidence, { toolUseId: "tool", description: "Inspect implementation", agentType: "Explore" });
  assert.equal(relation.confidence, "confirmed");
  assert.equal(projected.conversations.filter(row => row.kit_name === "agent-graph-001").length, 2);
  service.ledger.append({ source: "kit", source_event_id: "kit-root-request", kind: "delegation.created", subject: "delegation:kit-root-request",
    payload: { request_id: "kit-root-request", title: "Inspect", role: "implement", attempt: 1, state: "received", kit: { session: "agent-graph-001", file: join(kitState, "events.jsonl") } },
    source_ts: TS, confidence: "confirmed" } as FactInput);
  const feed = new ProjectionFeed(f.dbPath, () => service.catchUp());
  t.after(() => feed.close());
  const rows = feed.snapshot().projection.roots;
  assert.equal(feed.snapshot().projection.delegations[0].root_id, rows[0].id);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].conversation_ids, [createNativeId("claude", "first"), createNativeId("claude", "second")]);
  assert.equal(rows[0].name, "agent-graph-001");
  assert.equal(rows[0].total_children, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "name", "project", "state", "last_activity_ts", "conversation_ids", "running_children", "total_children"].sort());
});
