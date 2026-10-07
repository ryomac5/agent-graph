import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { openLedger, project } from "../../core/src/ledger/index.ts";
import { migrations } from "../../core/src/store/migrations.ts";
import { extractProvisionalName } from "../../core/src/ledger/projections/conversations.ts";
import type { MigrationReport } from "../src/migrate/index.ts";
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
  // 旧 daemon の waiting はターンの根拠ではないので、状態の規則により不明になる。
  assert.equal(projection.runs.filter((run) => run.state === "unknown").length, 5);
  assert.equal(projection.runs.find((run) => run.reason === "missing_turn_evidence")?.state, "unknown");
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
  assert.equal(ledger.readSince(0, 100).length, initial + 4);
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
  // 旧 daemon の running は常駐の確認であり、ターンの根拠ではない。状態の規則により不明にする。
  assert.equal(project(ledger.readSince(0, 100)).runs[0].state, "unknown");
  assert.equal(project(ledger.readSince(0, 100)).runs[0].reason, "missing_turn_evidence");
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

test("planner は作業として起源を残し、委譲との確かな関係を二重に作らない", async (t) => {
  const { path, db, ledger, addSession } = createFixture(t);
  addSession("planner");
  addSession("child");
  db.prepare("UPDATE sessions SET client = 'planner', goal = 'plan work' WHERE id = 'planner'").run();
  db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status)
    VALUES ('planned', 'old', 'planner', 'implement', 'planned task', 'done')`).run();
  db.prepare("INSERT INTO delegation_rounds VALUES ('planned', 1, 'request', 'implement', ?)").run(TS);
  const report = await migrateLegacyDatabases([path], ledger);
  const facts = ledger.readSince(0, 1000);
  const projection = project(facts);
  const plannerTask = facts.find((fact) => fact.kind === "task.created" && fact.payload?.purpose === "plan work")!;
  assert.equal((plannerTask.payload as { origin?: string }).origin, "planner");
  assert.equal(projection.tasks.length, 2);
  assert.deepEqual(projection.conversations.map((conversation) => conversation.native_id), ["child"]);
  assert.equal(projection.runs.length, 1);
  assert.equal(projection.delegations[0].request_id, "planned");
  assert.equal(projection.delegations[0].state, "done");
  assert.equal(projection.delegations[0].parent_run_id, undefined);
  const relation = projection.relations.find((relation) => relation.type === "delegated")!;
  assert.equal(relation.from_id, plannerTask.subject.slice("task:".length));
  assert.equal(relation.to_id, projection.delegations[0].id);
  assert.equal(relation.confidence, "confirmed");
  assert.equal(report.unsupported, 0);
  assert.equal(report.unknown, 0);
  assert.equal(report.inferred, 0);
  assert.deepEqual(report.errors, []);
  assert.equal(report.rows.sessions, 2);
  assert.deepEqual(report.facts, {
    "project.created": 1, "task.created": 2, "alias.created": 2,
    "conversation.created": 1, "run.created": 1, "run.state_changed": 1,
    "delegation.created": 1, "relation.created": 1, "delegation.state_changed": 1, "delegation.attempt_created": 1,
  });
  assert.equal(report.rows.graphs, undefined);
  assert.equal(report.rows.tasks, undefined);
  assert.deepEqual(await migrateLegacyDatabases([path], ledger), report);
  assert.deepEqual(ledger.readSince(0, 1000), facts);
});

test("未知の client と写せない行は未対応にし、後続行と DB を最後まで写す", async (t) => {
  const first = createFixture(t, "first");
  const second = createFixture(t, "second");
  first.addSession("unknown");
  first.addSession("valid", "ended", "idle");
  second.addSession("valid");
  first.db.prepare("UPDATE sessions SET client = 'future-client' WHERE id = 'unknown'").run();
  first.db.prepare("UPDATE sessions SET source_thread_id = 'unseen' WHERE id = 'valid'").run();
  first.db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES ('unsupported', 'unknown', ?, 'text'), ('valid', 'valid', ?, 'text')").run(TS, TS);
  first.db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status, scope)
    VALUES ('broken', 'first', 'valid', 'implement', 'broken JSON', 'pending', '{'),
      ('valid', 'first', 'valid', 'implement', 'valid', 'done', '[]'),
      ('unknown-parent', 'first', 'unknown', 'implement', 'unknown parent', 'pending', '[]')`).run();
  first.db.prepare("INSERT INTO delegation_requests VALUES ('valid', '{')").run();
  first.db.prepare("INSERT INTO delegation_rounds VALUES ('broken', 1, 'request', 'text', ?), ('valid', 1, 'request', 'text', ?)").run(TS, TS);
  first.db.exec("PRAGMA ignore_check_constraints = ON");
  first.db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status, kind)
    VALUES ('future-kind', 'first', 'valid', 'implement', 'future', 'pending', 'future-kind')`).run();
  first.db.prepare("INSERT INTO delegation_rounds VALUES ('valid', 2, 'future-kind', 'text', ?)").run(TS);
  const report = await migrateLegacyDatabases([first.path, second.path], first.ledger);
  const facts = first.ledger.readSince(0, 1000);
  const projection = project(facts);
  assert.equal(report.databases, 2);
  assert.equal(report.rows.sessions, 3);
  assert.equal(report.unsupported, 7);
  assert.equal(report.facts["observation.unsupported"], 7);
  assert.equal(report.facts["task.created"], 2);
  assert.equal(report.facts["delegation.created"], 2);
  assert.equal(report.facts["delegation.attempt_created"], 1);
  assert.equal(report.unknown, 2);
  assert.equal(report.inferred, 2);
  assert.deepEqual(report.errors, []);
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.delegations.find((row) => row.request_id === "valid")?.state, "done");
  assert.equal(projection.delegations.find((row) => row.request_id === "unknown-parent")?.parent.confidence, "unknown");
  assert.ok(facts.some((fact) => fact.kind === "observation.unsupported" && fact.payload?.reason?.includes("future-client")));
  assert.equal(Object.values(report.facts).reduce((total, count) => total + count!, 0), facts.length);
  assert.deepEqual(await migrateLegacyDatabases([first.path, second.path], first.ledger), report);
  assert.deepEqual(first.ledger.readSince(0, 1000), facts);
});

test("CLI は読めない DB を誤り一覧へ入れ、planner と未知 client を移して終了コード 0 と JSON を返す", (t) => {
  const { directory, path, db, addSession } = createFixture(t);
  addSession("planner");
  addSession("unknown");
  addSession("valid");
  db.prepare("UPDATE sessions SET client = 'planner' WHERE id = 'planner'").run();
  db.prepare("UPDATE sessions SET client = 'future-client' WHERE id = 'unknown'").run();
  db.prepare(`INSERT INTO delegations (id, repo_key, session_id, role, title, status)
    VALUES ('planned', 'old', 'planner', 'implement', 'task', 'done')`).run();
  const unreadable = join(directory, "broken.db");
  writeFileSync(unreadable, "not a sqlite database");
  const original = readFileSync(path);
  const destination = join(directory, "ledger.db");
  function runMigration(): MigrationReport {
    const result = spawnSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname,
      "migrate", "--from", directory, "--db", destination], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const report = runMigration();
  assert.equal(report.databases, 1);
  assert.equal(report.unsupported, 1);
  assert.equal(report.facts["delegation.created"], 1);
  assert.equal(report.facts["relation.created"], 1);
  assert.equal(report.facts["task.created"], 2);
  assert.equal(report.facts["conversation.created"], 1);
  assert.equal(report.unknown, 0);
  assert.equal(report.inferred, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].path, unreadable);
  assert.ok(report.errors[0].reason);
  const ledger = openLedger(destination);
  t.after(() => ledger.close());
  const facts = ledger.readSince(0, 1000);
  assert.equal(Object.values(report.facts).reduce((total, count) => total + count!, 0), facts.length);
  assert.deepEqual(runMigration(), report);
  assert.deepEqual(ledger.readSince(0, 1000), facts);
  assert.deepEqual(readFileSync(path), original);
});

function createRepositories(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-migrate-repos-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });
  const main = join(dir, "projects/agent-graph");
  const store = join(dir, "cache/agent-graph/worktrees");
  const scratch = join(dir, "scratch");
  mkdirSync(main, { recursive: true });
  git("init", "--quiet", main);
  git("-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const worktrees = ["A1", "W1", "Z1"].map((name) => join(store, "agent-graph-1234/graph", name));
  for (const worktree of worktrees) assert.equal(git("-C", main, "worktree", "add", "--quiet", "--detach", worktree).status, 0);
  const temporary = join(scratch, "codexpick.xPbN");
  mkdirSync(temporary, { recursive: true });
  git("init", "--quiet", temporary);
  const rows: [string, string, string][] = [
    ["agent-graph", main, "agent-graph"], ...worktrees.map((path, index) => [`wt-${index}`, path, path.split("/").at(-1)!] as [string, string, string]),
    ["codexpick", temporary, "codexpick.xPbN"], ["deleted", join(dir, "deleted"), "deleted"],
  ];
  function createLegacy(name: string, order: [string, string, string][]): string {
    const path = join(dir, `${name}.db`);
    const db = new DatabaseSync(path);
    for (const migration of migrations) db.exec(migration.sql);
    for (const row of order) db.prepare("INSERT INTO repos VALUES (?, ?, ?)").run(...row);
    for (const [key] of order) {
      db.prepare(`INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status)
        VALUES (?, ?, ?, 'codex', 'trace', ?, 'running')`).run(`session-${key}`, key, `${key}-1`, TS);
    }
    db.close();
    return path;
  }
  return { dir, main, temporaryRoots: [scratch, store], rows, createLegacy };
}

test("作業ツリーの行は本体のプロジェクトに写し、表示名は本体の名前で行の順序に依存しない", async (t) => {
  const f = createRepositories(t);
  const results = [];
  for (const [name, order] of [["forward", f.rows], ["reverse", [...f.rows].reverse()]] as const) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    const path = f.createLegacy(name, [...order]);
    await migrateLegacyDatabases([path], ledger, { temporaryRoots: f.temporaryRoots });
    const facts = ledger.readSince(0, 1000);
    const projection = project(facts);
    const registered = projection.projects.filter((entry) => entry.state === "registered");
    assert.equal(registered.length, 1);
    assert.equal(registered[0].display_name, "agent-graph");
    assert.equal(registered[0].name_prefix, "agent-graph");
    assert.equal(registered[0].root_path, f.main);
    // 作業ツリーの行の事実も本体の名前と場所を持つ。
    const created = facts.filter((entry) => entry.subject === `project:${registered[0].id}`);
    assert.equal(created.length, 4);
    for (const fact of created) {
      assert.ok(fact.kind === "project.created");
      assert.equal(fact.payload?.display_name, "agent-graph");
      assert.equal(fact.payload?.root_path, f.main);
    }
    const temporary = projection.projects.find((entry) => entry.display_name === "codexpick.xPbN")!;
    assert.equal(temporary.state, "unregistered");
    assert.equal(projection.projects.find((entry) => entry.display_name === "deleted")?.state, "unregistered");
    // 登録しないリポジトリの会話も、観測した会話として残す。
    assert.equal(projection.conversations.length, f.rows.length);
    assert.ok(projection.conversations.every((conversation) => conversation.origin === "observed"));
    assert.ok(projection.tasks.some((task) => task.project === temporary.id));
    results.push(projection.projects);
  }
  assert.deepEqual(results[0], results[1]);
});

test("旧い移行が作業ツリーの名前で写した台帳も、再移行で本体の名前に訂正し、2 回目は増えない", async (t) => {
  const f = createRepositories(t);
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const path = f.createLegacy("stale", f.rows);
  // 旧い移行と同じく、各行のパスと名前のまま登録した状態を作る。
  await migrateLegacyDatabases([path], ledger, { temporaryRoots: [], git: (args) => {
    const result = spawnSync("git", args, { encoding: "utf8" });
    return args.includes("worktree") ? { status: result.status ?? 1, stdout: `worktree ${args[1]}\n` } : { status: result.status ?? 1, stdout: result.stdout };
  } });
  const stale = project(ledger.readSince(0, 1000)).projects;
  assert.ok(stale.filter((entry) => entry.state === "registered").length >= 2);
  await migrateLegacyDatabases([path], ledger, { temporaryRoots: f.temporaryRoots });
  const facts = ledger.readSince(0, 1000);
  const registered = project(facts).projects.filter((entry) => entry.state === "registered");
  assert.deepEqual(registered.map((entry) => [entry.display_name, entry.root_path]), [["agent-graph", f.main]]);
  await migrateLegacyDatabases([path], ledger, { temporaryRoots: f.temporaryRoots });
  assert.equal(ledger.readSince(0, 1000).length, facts.length);
});

test("移行の作業の名前は、会話の名前と同じ core の規則で旧い依頼から作る", async (t) => {
  const { db, path, ledger, addSession } = createFixture(t);
  const prompts = {
    injected: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n# 規約\n</INSTRUCTIONS>\n<task>\n検索を速くする。続き\n</task>",
    review: "Review a delegated task. Do not edit files.\n\nOriginal request:\n{\"title\":\"検索を速くする\",\"task\":\"検索\"}\n",
    unattended: "無人実行です。質問せずに作業を完了し、最後に結果を報告してください。\n元の依頼:\n# タスク D1: 画面への配信を作る\n本文",
  };
  for (const [id, prompt] of Object.entries(prompts)) {
    addSession(id, "ended", "idle");
    db.prepare("INSERT INTO turns (id, session_id, at, prompt) VALUES (?, ?, ?, ?)").run(`turn-${id}`, id, TS, prompt);
  }
  await migrateLegacyDatabases([path], ledger);
  const projection = project(ledger.readSince(0, 1000));
  const taskName = (id: string) => projection.tasks.find(task => task.id === projection.conversations.find(row => row.native_id === id)!.task_id)?.name;
  for (const [id, prompt] of Object.entries(prompts)) assert.equal(taskName(id), extractProvisionalName(prompt), id);
  assert.deepEqual(Object.keys(prompts).map(taskName), ["検索を速くする。", "Review of 検索を速くする", "画面への配信を作る"]);
});
