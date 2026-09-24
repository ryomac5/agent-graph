import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrate, migrations } from "../src/index.ts";

test("空の DB に全表と schema_version の版1を作り、再実行しても変わらない", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const versions = db.prepare("SELECT * FROM schema_version").all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.equal(new Date(versions[0].applied_at as string).toISOString(), versions[0].applied_at);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.deepEqual(tables.map((row) => row.name).sort(), [
    "schema_version", "repos", "sessions", "graphs", "tasks", "delegations", "assignments",
    "spans", "events", "acceptances", "reviews", "usage_samples", "token_usage",
  ].sort());
  migrate(db);
  assert.deepEqual(db.prepare("SELECT * FROM schema_version").all(), versions);
});

test("追加の移行で版1から版2に進み、版2も再適用しない", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  const steps = [...migrations, { version: 2, sql: "CREATE TABLE extra (id TEXT);" }];
  migrate(db, steps);
  migrate(db, steps);
  assert.deepEqual(db.prepare("SELECT version FROM schema_version ORDER BY version").all()
    .map((row) => row.version), [1, 2]);
});

test("失敗した版だけをロールバックし、修正後に再実行できる", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  assert.throws(() => migrate(db, [...migrations, {
    version: 2,
    sql: "CREATE TABLE partial (id TEXT); INSERT INTO missing VALUES (1);",
  }]), /missing/);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version, 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(), undefined);
  migrate(db, [{ version: 2, sql: "CREATE TABLE partial (id TEXT);" }]);
  assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version, 2);
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
