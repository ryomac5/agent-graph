import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrate, migrations } from "../src/index.ts";

const allTables = [
  "schema_version", "repos", "sessions", "graphs", "tasks", "delegations", "assignments",
  "spans", "events", "acceptances", "reviews", "usage_samples", "token_usage", "turns", "task_decisions",
].sort();

test("空の DB に全表と schema_version の版1と版2を作り、再実行しても変わらない", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const versions = db.prepare("SELECT * FROM schema_version ORDER BY version").all();
  assert.deepEqual(versions.map((row) => row.version), [1, 2]);
  assert.equal(new Date(versions[0].applied_at as string).toISOString(), versions[0].applied_at);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.deepEqual(tables.map((row) => row.name).sort(), allTables);
  migrate(db);
  assert.deepEqual(db.prepare("SELECT * FROM schema_version ORDER BY version").all(), versions);
});

test("版1の DB を版2に移行し、既存の行に既定値が入り、2 回流しても同じ", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db, [migrations[0]]);
  db.prepare("INSERT INTO repos (key, root_path, name) VALUES ('r', '/r', 'repo')").run();
  db.prepare("INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at) VALUES ('s', 'r', 'repo-001', 'claude', 'a', '2026-09-25T00:00:00.000Z')").run();
  db.prepare("INSERT INTO delegations (id, repo_key, session_id, role, title, status) VALUES ('d', 'r', 's', 'implement', 'd', 'running')").run();
  migrate(db);
  const snapshot = () => ({
    versions: db.prepare("SELECT version FROM schema_version ORDER BY version").all().map((row) => row.version),
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name).sort(),
    session: db.prepare("SELECT * FROM sessions").get(),
    delegation: db.prepare("SELECT * FROM delegations").get(),
  });
  const first = snapshot();
  assert.deepEqual(first.versions, [1, 2]);
  assert.deepEqual(first.tables, allTables);
  assert.equal(first.session!.status, "running");
  assert.equal(first.session!.last_seen_at, "2026-09-25T00:00:00.000Z");
  assert.equal(first.session!.ended_at, null);
  assert.equal(first.session!.pid, null);
  assert.equal(first.delegation!.kind, "delegation");
  const columns = db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  for (const column of ["name", "status", "ended_at", "pid", "pid_started_at", "waiting_reason", "goal", "model", "last_seen_at"]) {
    assert.ok(columns.includes(column), column);
  }
  assert.deepEqual(db.prepare("PRAGMA table_info(turns)").all().map((row) => row.name),
    ["id", "session_id", "at", "prompt", "summary", "reply", "hidden"]);
  assert.deepEqual(db.prepare("PRAGMA table_info(task_decisions)").all().map((row) => row.name),
    ["graph_id", "task_id", "action", "at"]);
  migrate(db);
  assert.deepEqual(snapshot(), first);
});

test("追加の移行で版2から版3に進み、版3も再適用しない", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const steps = [...migrations, { version: 3, sql: "CREATE TABLE extra (id TEXT);" }];
  migrate(db, steps);
  migrate(db, steps);
  assert.deepEqual(db.prepare("SELECT version FROM schema_version ORDER BY version").all()
    .map((row) => row.version), [1, 2, 3]);
});

test("失敗した版だけをロールバックし、修正後に再実行できる", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.throws(() => migrate(db, [...migrations, {
    version: 3,
    sql: "CREATE TABLE partial (id TEXT); INSERT INTO missing VALUES (1);",
  }]), /missing/);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version, 2);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(), undefined);
  migrate(db, [{ version: 3, sql: "CREATE TABLE partial (id TEXT);" }]);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version, 3);
});

test("初回移行の失敗では schema_version 自体もロールバックする", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.throws(() => migrate(db, [{
    version: 1, sql: migrations[0].sql + "INSERT INTO missing VALUES (1);",
  }]));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'")
    .get()!.count, 0);
  migrate(db);
});

test("移行版の重複と不正値は適用前に拒否する", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.throws(() => migrate(db, [...migrations, migrations[0]]), TypeError);
  assert.throws(() => migrate(db, [{ version: 0, sql: "" }]), TypeError);
});
