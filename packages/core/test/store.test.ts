import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, ulid, type Event, type Span } from "../src/index.ts";

const trace = { traceId: "1".repeat(32), spanId: "2".repeat(16) };
const ts = "2026-09-25T00:00:00.000Z";
const repo = { key: "repo", rootPath: "/work/repo", name: "repo" };

function makeEvent(): Event<"guard.denied"> {
  return { id: ulid(), ts, kind: "guard.denied", repo: repo.key, trace,
    payload: { command: "git push", reason: "禁止操作" } };
}

test("Event は任意の trace 文脈と session を含めて往復し、repo で絞れる", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo(repo);
  store.upsertRepo({ ...repo, name: "renamed" });
  assert.equal(store.db.prepare("SELECT name FROM repos").get()!.name, "renamed");
  store.insertSession({
    id: "session", repoKey: repo.key, name: "repo-1", client: "codex",
    traceId: trace.traceId, startedAt: ts,
  });
  const first = makeEvent();
  const second = { ...makeEvent(), session: "session", trace: {
    ...trace, parentSpanId: "3".repeat(16), traceState: "vendor=value",
  } };
  store.appendEvent(second);
  store.appendEvent(first);
  assert.deepEqual(store.listEvents(), [first, second]);
  assert.deepEqual(store.listEvents(repo.key), [first, second]);
  assert.deepEqual(store.listEvents("missing"), []);
  const row = store.db.prepare("SELECT * FROM events WHERE id = ?").get(second.id)!;
  assert.equal(row.trace_id, trace.traceId);
  assert.equal(row.span_id, trace.spanId);
  assert.deepEqual(JSON.parse(row.payload as string), second.payload);
  assert.throws(() => store.appendEvent({ ...makeEvent(), repo: "missing" }), /FOREIGN KEY/);
});

test("events の UPDATE、DELETE、REPLACE と重複追記を拒否する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo(repo);
  const event = makeEvent();
  store.appendEvent(event);
  assert.throws(() => store.db.exec("UPDATE events SET kind = 'usage.sampled'"), /append-only/);
  assert.throws(() => store.db.exec("DELETE FROM events"), /append-only/);
  assert.throws(() => store.db.exec("INSERT OR REPLACE INTO events SELECT * FROM events"), /append-only/);
  assert.throws(() => store.appendEvent(event), /append-only/);
  assert.deepEqual(store.listEvents(), [event]);
});

test("span の開始と終了は trace_id と span_id の組で識別する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const span: Span = {
    trace, name: "delegate", startedAt: ts, status: "unset",
    attributes: {
      "agent.role": "implement", "agent.executor": "codex", "agent.model": "model",
      "agent.session": "session", "agent.delegation": "delegation", count: 1, active: true,
    },
  };
  store.insertSpan(span);
  store.insertSpan({ ...span, trace: { ...trace, traceId: "4".repeat(32) } });
  const before = store.db.prepare("SELECT * FROM spans WHERE trace_id = ?").get(trace.traceId)!;
  assert.equal(before.ended_at, null);
  assert.equal(before.status, "unset");
  assert.deepEqual(JSON.parse(before.attributes as string), span.attributes);
  const endedAt = "2026-09-25T00:01:00.000Z";
  store.endSpan(trace.traceId, trace.spanId, endedAt, "ok");
  const after = store.db.prepare("SELECT * FROM spans WHERE trace_id = ?").get(trace.traceId)!;
  assert.equal(after.ended_at, endedAt);
  assert.equal(after.status, "ok");
  assert.equal(store.db.prepare("SELECT status FROM spans WHERE trace_id = ?")
    .get("4".repeat(32))!.status, "unset");
  assert.throws(() => store.endSpan(trace.traceId, "missing", endedAt, "error"), /not found/);
});

test("親ディレクトリを作成し WAL と外部キーを有効にして再オープンできる", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "nested", "agent-graph.db");
  const store = openStore(path);
  const event = makeEvent();
  try {
    assert.equal(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    assert.equal(store.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    store.upsertRepo(repo);
    store.appendEvent(event);
  } finally {
    store.close();
  }
  const reopened = openStore(path);
  try {
    assert.deepEqual(reopened.listEvents(), [event]);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_version").get()!.count, 1);
  } finally {
    reopened.close();
  }
});
