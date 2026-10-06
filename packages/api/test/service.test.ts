import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { createNativeId, openLedger, project } from "../../core/src/ledger/index.ts";
import { migrations } from "../../core/src/store/migrations.ts";
import { openObservationService } from "../src/service/index.ts";
import { pollObservation } from "../src/service/poll.ts";
import { runCli } from "../src/cli.ts";

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
  assert.equal(report.appended, messages * 2 + BULK_FILE_COUNT + 1);
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
  assert.equal(next.appended, 7);
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
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(readFileSync(join(state, "counter"), "utf8"), "999");
  const external = openLedger(f.dbPath);
  external.append({ source: "hook", source_event_id: "external", kind: "run.state_changed", subject: "run:claude:session:1",
    payload: { generation: 1, state: "running" }, source_ts: "2026-10-06T11:00:00.000Z", confidence: "confirmed" });
  external.close();
  const stateAfter = service.catchUp();
  assert.equal(stateAfter.last_seq, 5);
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
    assert.ok(stderr.includes("Conflicting hook event"));
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
    assert.equal(readProjection(f.dbPath).state!.last_seq, facts.at(-1)!.seq);
    child.kill(signal);
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(ready.hook_endpoint_file), false);
    await assert.rejects(fetch(endpoint.url));
  });
}

test("待ち受けを代替しても serve の初回失敗・定期再試行・停止と後始末を検証する", async (t) => {
  const f = createFixture(t);
  const previousEnv = { ...process.env };
  Object.assign(process.env, f.env);
  t.after(() => { process.env = previousEnv; });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const outbox = join(f.state, "agent-graph", "outbox");
  mkdirSync(outbox);
  const conflict = join(outbox, "conflict.json");
  writeFileSync(conflict, JSON.stringify(HOOK_EVENT));
  f.run("ingest", "--once");
  writeFileSync(conflict, JSON.stringify({ ...HOOK_EVENT, input: { changed: true } }));
  writeFileSync(join(outbox, "00-invalid.json"), "{");
  let closed = false;
  const server = Object.assign(new EventEmitter(), {
    listen: (_port: number, _host: string, callback: () => void) => { queueMicrotask(callback); },
    address: () => ({ port: 12345, address: "127.0.0.1", family: "IPv4" }),
    close: (callback: () => void) => { closed = true; callback(); },
    closeIdleConnections: () => {},
  });
  t.mock.method(http, "createServer", () => server);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const errors: string[] = [];
  t.mock.method(console, "error", (message: string) => errors.push(message));
  let ready: Record<string, string> = {};
  let resolveReady = () => {};
  const started = new Promise<void>((resolve) => { resolveReady = resolve; });
  t.mock.method(console, "log", (message: string) => { ready = JSON.parse(message); resolveReady(); });
  const serving = runCli(["serve"]);
  await Promise.race([started, serving.then(() => assert.fail("serve exited before starting"))]);
  try {
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes("Conflicting hook event"));
    assert.equal(fs.existsSync(ready.hook_endpoint_file), true);
    rmSync(conflict);
    writeFileSync(join(outbox, "recovered.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "recovered", hook_event_name: "Stop" }));
    t.mock.timers.tick(1000);
    assert.ok(f.read().some((fact) => fact.source_event_id.includes("recovered")));
    writeFileSync(conflict, JSON.stringify({ ...HOOK_EVENT, input: { changed: true } }));
    t.mock.timers.tick(1000);
    assert.equal(errors.length, 2);
    assert.equal(closed, false);
    rmSync(conflict);
    writeFileSync(join(outbox, "later.json"), JSON.stringify({ ...HOOK_EVENT, event_id: "later", hook_event_name: "Stop" }));
    t.mock.timers.tick(1000);
    const facts = f.read();
    assert.ok(facts.some((fact) => fact.source_event_id.includes("later")));
    assert.equal(facts.filter((fact) => fact.kind === "observation.unsupported").length, 1);
    assert.equal(readProjection(f.dbPath).state!.last_seq, facts.at(-1)!.seq);
  } finally {
    process.emit("SIGTERM");
    await serving;
  }
  assert.equal(closed, true);
  assert.equal(fs.existsSync(ready.hook_endpoint_file), false);
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
  test(`取り込みの投影は ${live ? "常駐で 500 ms ごと" : "一回の走査の終了時"} にまとめる`, (t) => {
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
    assert.equal(service.ingestOnce().appended, 7);
    assert.deepEqual(positions, live ? [0, 2, 2, 4, 4, 6, 6] : [0, 0, 0, 0, 0, 0, 0]);
    assert.equal(reader.prepare("SELECT last_seq FROM projection_state").get()!.last_seq, 7);
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
