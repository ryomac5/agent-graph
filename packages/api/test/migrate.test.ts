import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { openLedger, project } from "../../core/src/ledger/index.ts";
import { migrations } from "../../core/src/store/migrations.ts";
import { migrateLegacyDatabases } from "../src/migrate/index.ts";

const TS = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";

function createFixture(t: TestContext, name = "old") {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-migrate-"));
  const path = join(directory, `${name}.db`);
  const db = new DatabaseSync(path);
  for (const migration of migrations) db.exec(migration.sql);
  const ledger = openLedger(":memory:");
  t.after(() => { db.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run(name, join(directory, "deleted-repo"), "example");
  function addSession(id: string, status = "running", reason: string | null = null) {
    db.prepare(`INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status, ended_reason, ended_at)
      VALUES (?, ?, ?, 'codex', 'trace', ?, ?, ?, ?)`).run(id, name, `example-${id}`, TS, status, reason, status === "ended" ? LATER : null);
  }
  return { directory, path, db, ledger, addSession };
}

test("旧行の規則を写し、二度の変換で件数・台帳・旧 DB の内容が変わらない", async (t) => {
  const { directory, path, db, ledger, addSession } = createFixture(t);
  addSession("first", "ended", "idle");
  addSession("next", "ended", "explicit");
  addSession("exit", "ended", "process_exit");
  addSession("missing", "ended");
  addSession("waiting", "waiting");
  db.prepare("UPDATE sessions SET continued_in = 'next', source_thread_id = 'thread' WHERE id = 'first'").run();
  db.prepare("INSERT INTO turns (id, session_id, at, prompt, reply, summary) VALUES ('turn', 'first', ?, ?, ?, 'summary')")
    .run(TS, `prompt ${SECRET}`, `reply ${SECRET}`);
  db.prepare("INSERT INTO turns (id, session_id, at, prompt, hidden) VALUES ('hidden', 'next', ?, '', 1)").run(TS);
  db.prepare("INSERT INTO session_commands VALUES ('first', ?, 'git commit -m forbidden-command')").run(TS);
  db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status, round_trips, task, scope, outputs, output)
    VALUES ('d', 'old', 'first', 'implement', 'task', 'done', 1, 'request', '["src/**"]', '["result"]', 'complete')`).run();
  db.prepare("INSERT INTO delegation_requests VALUES ('d', ?)").run(JSON.stringify({ task: "request", scope: ["src/**"] }));
  db.prepare("INSERT INTO delegation_rounds VALUES ('d', 1, 'request', 'do it', ?), ('d', 2, 'report', 'done', ?)").run(TS, LATER);
  db.prepare("INSERT INTO assignments VALUES ('d', 'codex', 'model', 'family', 'tier', 'reason', 'v1')").run();
  db.prepare("INSERT INTO acceptances VALUES ('d', 1, ?, '[]')").run(JSON.stringify([{ passed: true }]));
  db.prepare("INSERT INTO reviews VALUES ('d', 'd', 'approve', 'good')").run();
  const original = readFileSync(path);
  const first = await migrateLegacyDatabases([path], ledger);
  const facts = ledger.readSince(0, 1000);
  const projection = project(facts);
  assert.deepEqual(await migrateLegacyDatabases([path], ledger), first);
  assert.deepEqual(ledger.readSince(0, 1000), facts);
  assert.deepEqual(project(ledger.readSince(0, 1000)), projection);
  assert.deepEqual(readFileSync(path), original);
  assert.equal(first.databases, 1);
  assert.equal(first.rows.sessions, 5);
  assert.equal(first.rows.turns, 2);
  assert.equal(first.rows.session_commands, undefined);
  assert.equal(first.unknown, 3);
  // core は legacy の explicit を終了の根拠として認めない。報告は変換時の件数である。
  assert.equal(projection.runs.filter((run) => run.state === "unknown").length, 4);
  assert.equal(projection.runs.find((run) => run.reason === "unconfirmed_end_evidence")?.state, "unknown");
  assert.equal(first.inferred, 2);
  assert.ok(facts.every((fact) => fact.source === "legacy"));
  assert.equal(projection.projects.length, 1);
  assert.equal(projection.tasks.length, 5);
  assert.equal(projection.conversations.length, 6);
  const states = facts.filter((fact) => fact.kind === "run.state_changed");
  assert.equal(states.filter((fact) => fact.payload?.state === "unknown").length, 3);
  const ended = states.find((fact) => fact.payload?.state === "ended")!;
  assert.equal(ended.confidence, "confirmed");
  assert.equal(ended.payload?.ended_ts, LATER);
  assert.deepEqual(ended.payload?.end_evidence, { kind: "explicit", legacy_reason: "explicit" });
  assert.ok(projection.runs.some((run) => run.reason?.includes("idle")));
  assert.ok(projection.runs.some((run) => run.reason?.includes("process_exit")));
  assert.ok(projection.runs.filter((run) => run.state === "unknown").every((run) => run.ended_ts === undefined));
  const relations = facts.filter((fact) => fact.kind === "relation.created");
  assert.equal(relations.find((fact) => fact.payload?.type === "continued")?.confidence, "confirmed");
  assert.equal(relations.find((fact) => fact.payload?.evidence && JSON.stringify(fact.payload.evidence).includes("source_thread_id"))?.confidence, "inferred");
  assert.ok(facts.filter((fact) => fact.kind === "alias.created").every((fact) => fact.payload?.kind === "legacy"));
  assert.equal(projection.messages.length, 3);
  assert.ok(projection.messages.some((message) => message.native_id === "turn:prompt"));
  assert.ok(projection.messages.some((message) => message.native_id === "turn:reply"));
  assert.equal(projection.message_memberships.filter((member) => member.active === false).length, 1);
  assert.equal(JSON.stringify(facts).includes(SECRET), false);
  assert.equal(JSON.stringify(facts).includes("forbidden-command"), false);
  assert.ok(JSON.stringify(facts).includes("[REDACTED:anthropic:"));
  assert.equal(projection.delegations[0].request_id, "d");
  assert.equal(projection.delegations[0].state, "done");
  assert.equal(projection.delegations[0].parent.confidence, "confirmed");
  const attempts = facts.filter((fact) => fact.kind === "delegation.attempt_created");
  assert.equal(attempts.length, 5);
  assert.ok(attempts.some((fact) => fact.payload?.assignment && JSON.stringify(fact.payload.assignment).includes("model")));
  assert.ok(attempts.some((fact) => fact.payload?.verification && JSON.stringify(fact.payload.verification).includes('"passed":true')));
  assert.ok(attempts.some((fact) => fact.payload?.review && JSON.stringify(fact.payload.review).includes("approve")));
  const backups = readdirSync(`${path}.migration-backups`);
  assert.equal(backups.length, 1);
  for (const name of backups) {
    const backup = new DatabaseSync(join(`${path}.migration-backups`, name), { readOnly: true });
    assert.equal(backup.prepare("SELECT count(*) AS n FROM turns").get()!.n, 2);
    backup.close();
  }
  assert.ok(readdirSync(directory).includes("old.db"));
});

test("稼働中の WAL も複製し、バックアップが失敗すると台帳に追記しない", async (t) => {
  const { path, db, ledger, addSession } = createFixture(t);
  db.exec("PRAGMA journal_mode = WAL");
  addSession("wal");
  const before = readFileSync(path);
  const walBefore = readFileSync(`${path}-wal`);
  await migrateLegacyDatabases([path], ledger);
  assert.equal(project(ledger.readSince(0, 100)).tasks.length, 1);
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(readFileSync(`${path}-wal`), walBefore);
  const empty = openLedger(":memory:");
  t.after(() => empty.close());
  await assert.rejects(migrateLegacyDatabases([path], empty, { backupDirectory: path }));
  assert.equal(empty.readSince(0, 10).length, 0);
});

test("同時刻の可変行は直前の版を置き換え、再起動と以前の値への復帰でも最新値を投影する", async (t) => {
  const { directory, path, db, addSession } = createFixture(t);
  addSession("live");
  db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status)
    VALUES ('d', 'old', 'live', 'implement', 'task', 'running')`).run();
  const ledgerPath = join(directory, "ledger.db");
  let ledger = openLedger(ledgerPath);
  t.after(() => ledger.close());
  await migrateLegacyDatabases([path], ledger);
  let previous = ledger.readSince(0, 1000);
  for (const [state, purpose, provider] of [
    ["done", "new goal", "claude"],
    ["failed", "changed goal", "codex"],
    ["running", "", "codex"],
    ["done", "new goal", "claude"],
  ]) {
    db.prepare("UPDATE delegations SET status = ? WHERE id = 'd'").run(state);
    db.prepare("UPDATE sessions SET goal = ?, client = ? WHERE id = 'live'").run(purpose, provider);
    const original = readFileSync(path);
    ledger.close();
    ledger = openLedger(ledgerPath);
    const report = await migrateLegacyDatabases([path], ledger);
    const facts = ledger.readSince(0, 1000);
    const projection = project(facts);
    assert.equal(projection.delegations[0].state, state);
    assert.equal(projection.delegations[0].attempt, 0);
    assert.equal(projection.tasks[0].purpose, purpose);
    assert.equal(projection.conversations[0].provider, provider);
    for (const fact of facts.slice(previous.length)) {
      const prior = previous.findLast((old) => old.kind === fact.kind && old.subject === fact.subject)!;
      assert.equal(fact.supersedes, prior.fact_id);
      assert.equal(fact.source_ts, prior.source_ts);
    }
    assert.equal(facts.filter((fact) => fact.kind === "delegation.state_changed").length,
      previous.filter((fact) => fact.kind === "delegation.state_changed").length + 1);
    assert.deepEqual(project([...facts].reverse()), projection);
    assert.deepEqual(await migrateLegacyDatabases([path], ledger), report);
    assert.deepEqual(ledger.readSince(0, 1000), facts);
    assert.deepEqual(readFileSync(path), original);
    const backups = readdirSync(`${path}.migration-backups`);
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(`${path}.migration-backups`, backups[0]), { readOnly: true });
    assert.equal(backup.prepare("SELECT status FROM delegations WHERE id = 'd'").get()!.status, state);
    backup.close();
    previous = facts;
  }
});

test("旧 DB の増分と可変行を再取り込みできる", async (t) => {
  const { path, db, ledger, addSession } = createFixture(t);
  addSession("live");
  await migrateLegacyDatabases([path, path], ledger);
  const initial = ledger.readSince(0, 100).length;
  db.prepare("UPDATE sessions SET status = 'ended', ended_reason = 'explicit', ended_at = ? WHERE id = 'live'").run(LATER);
  db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('later', 'live', ?, 'new')").run(LATER);
  const report = await migrateLegacyDatabases([path], ledger);
  assert.equal(report.databases, 1);
  assert.equal(ledger.readSince(0, 100).length, initial + 3);
  assert.ok(ledger.readSince(0, 100).some((fact) => fact.kind === "run.state_changed" && fact.payload?.state === "ended"));
  assert.deepEqual(await migrateLegacyDatabases([path], ledger), report);
});

test("版 1 の旧 DB では後から追加された表や列を要求しない", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-migrate-v1-"));
  const path = join(directory, "old.db");
  const db = new DatabaseSync(path);
  const ledger = openLedger(":memory:");
  t.after(() => { db.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(migrations[0].sql);
  db.prepare("INSERT INTO repos VALUES ('old', '/missing', 'old')").run();
  db.prepare("INSERT INTO sessions VALUES ('session', 'old', 'old-1', 'claude', 'trace', ?)").run(TS);
  const report = await migrateLegacyDatabases([path], ledger);
  assert.equal(report.rows.turns, undefined);
  assert.equal(project(ledger.readSince(0, 100)).runs[0].state, "running");
  assert.deepEqual(await migrateLegacyDatabases([path], ledger), report);
});

test("保存範囲 metadata なら本文を写さず、所属を残す", async (t) => {
  const { path, db, addSession } = createFixture(t);
  addSession("session");
  db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('t', 'session', ?, ?)").run(TS, SECRET);
  const ledger = openLedger(":memory:", { storageScope: "metadata" });
  t.after(() => ledger.close());
  await migrateLegacyDatabases([path], ledger);
  const projection = project(ledger.readSince(0, 100));
  assert.equal(projection.messages[0].body_state, "omitted");
  assert.equal(projection.messages[0].body, undefined);
  assert.equal(projection.message_memberships.length, 1);
});

test("本文の秘匿処理が失敗した行は空の本文と unavailable を記録する", async (t) => {
  const { path, db, ledger, addSession } = createFixture(t);
  addSession("session");
  db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('t', 'session', ?, ?)").run(TS, SECRET);
  const failingLedger = {
    ...ledger,
    append(input: Parameters<typeof ledger.append>[0]) {
      if (input.kind === "message.created" && input.payload.body !== "") throw new TypeError("redaction failed");
      return ledger.append(input);
    },
  };
  const first = await migrateLegacyDatabases([path], failingLedger);
  assert.deepEqual(await migrateLegacyDatabases([path], failingLedger), first);
  const projection = project(ledger.readSince(0, 100));
  assert.equal(projection.messages[0].body_state, "unavailable");
  assert.equal(projection.messages[0].body, "");
  assert.equal(projection.message_memberships.length, 1);
  assert.equal(JSON.stringify(ledger.readSince(0, 100)).includes(SECRET), false);
});

test("複数の旧 DB の同じ行 ID は別々に取り込む", async (t) => {
  const first = createFixture(t, "first");
  const second = createFixture(t, "second");
  first.addSession("same");
  second.addSession("same");
  const report = await migrateLegacyDatabases([first.path, second.path], first.ledger);
  assert.equal(report.databases, 2);
  assert.equal(report.rows.sessions, 2);
  const facts = first.ledger.readSince(0, 100);
  assert.equal(facts.filter((fact) => fact.kind === "conversation.created").length, 2);
  assert.equal(facts.filter((fact) => fact.kind === "task.created").length, 2);
  assert.deepEqual(await migrateLegacyDatabases([second.path, first.path], first.ledger), report);
  assert.deepEqual(first.ledger.readSince(0, 100), facts);
});
