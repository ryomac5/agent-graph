import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, ulid, type Event, type Span } from "../src/index.ts";

test("複数プロセスが空の DB を同時に開き、移行と書き込みを完了する", { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-concurrent-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = `
    import { openStore } from ${JSON.stringify(new URL("../src/store/store.ts", import.meta.url).href)};
    import { join } from 'node:path';
    process.send('ready');
    process.once('message', () => {
      for (let round = 0; round < 10; round++) {
        const store = openStore(join(process.env.TEST_STORE_DIR, round + '.db'));
        store.upsertRepo({ key: String(process.pid), rootPath: '/fixture', name: 'fixture' });
        store.close();
      }
      process.disconnect();
    });
  `;
  const workers = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      env: { ...process.env, TEST_STORE_DIR: dir }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    t.after(() => child.kill());
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve()); child.once("error", reject);
    });
    const completed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    return { child, ready, completed };
  });
  const completion = Promise.allSettled(workers.map((worker) => worker.completed));
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.send("start");
  for (const result of await completion) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
  for (let round = 0; round < 10; round++) {
    const store = openStore(join(dir, round + ".db"));
    try {
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM repos").get()!.n, workers.length);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get()!.n, 3);
    } finally { store.close(); }
  }
});

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
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM schema_version").get()!.count, 3);
  } finally {
    reopened.close();
  }
});

test("利用枠を追記してプロバイダ・モデル・枠ごとの最新値を読む", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const first = { ts: "2026-09-25T00:00:00Z", provider: "openai" as const,
    window: "300m", percent: 20 };
  const latest = { ...first, ts: "2026-09-25T01:00:00Z", percent: 40 };
  const model = { ...first, model: "gpt", percent: 30 };
  store.appendUsageSample(first);
  store.appendUsageSample(latest);
  store.appendUsageSample(model);
  assert.deepEqual(store.latestUsageSamples(), [latest, model]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get()!.count, 3);
});

test("onChange は委譲、割り当て、イベントの成功した書き込みだけを通知する", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo(repo);
  store.insertSession({ id: "session", repoKey: repo.key, name: "repo-1", client: "codex",
    traceId: trace.traceId, startedAt: ts });
  let changes = 0;
  const unsubscribe = store.onChange(() => { changes += 1; });
  store.insertDelegation({ id: "delegation", repoKey: repo.key, sessionId: "session",
    role: "implement", title: "task", status: "running" });
  store.insertAssignment("delegation", { executor: "codex", model: "gpt", family: "openai",
    tier: "mid", reason: [], policyVersion: "1" });
  store.finishDelegation("delegation", "done");
  store.appendEvent(makeEvent());
  assert.equal(changes, 4);
  assert.throws(() => store.appendEvent({ ...makeEvent(), repo: "missing" }), /FOREIGN KEY/);
  assert.equal(changes, 4);
  unsubscribe();
  store.appendEvent(makeEvent());
  assert.equal(changes, 4);
});

test("onChange のリスナー例外は書き込みと他のリスナーを妨げない", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo(repo);
  store.insertSession({ id: "session", repoKey: repo.key, name: "repo-1", client: "codex",
    traceId: trace.traceId, startedAt: ts });
  let changes = 0;
  store.onChange(() => { throw new Error("listener failed"); });
  store.onChange(() => { changes += 1; });
  assert.doesNotThrow(() => store.insertDelegation({ id: "delegation", repoKey: repo.key,
    sessionId: "session", role: "implement", title: "task", status: "running" }));
  assert.equal(changes, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM delegations").get()!.count, 1);
});

test("セッションの作成と client の変更を通知し、同値更新は通知しない", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo(repo);
  let changes = 0;
  store.onChange(() => { changes++; });
  store.insertSession({ id: "session", repoKey: repo.key, name: "repo-1", client: "mcp",
    traceId: trace.traceId, startedAt: ts });
  store.updateSessionClient("session", "codex");
  store.updateSessionClient("session", "codex");
  store.updateSessionClient("missing", "claude");
  assert.equal(changes, 2);
  assert.equal(store.db.prepare("SELECT client FROM sessions WHERE id = 'session'").get()?.client, "codex");
});

test("planner の指紋検索、タスク更新、判断イベントはグラフごとに独立する", (t) => {
  const store = openStore(":memory:"); t.after(() => store.close());
  store.upsertRepo(repo);
  store.insertSession({ id: "s", repoKey: repo.key, name: "s", client: "planner", traceId: trace.traceId, startedAt: ts });
  const graph = { id: "g", repoKey: repo.key, sessionId: "s", goal: "goal", fingerprint: "first", createdAt: ts };
  store.insertGraph(graph, [{ graphId: "g", id: "a", title: "A", role: "implement", dependsOn: [], state: "planned", attempts: 0 }]);
  store.updateTask("g", "a", "running", 1);
  store.updateTask("g", "a", "failed");
  assert.equal(store.listTasks("g")[0].attempts, 1);
  store.insertGraph({ ...graph, id: "g2", fingerprint: "second" }, []);
  assert.equal(store.findGraph(repo.key, "s", "first")?.id, "g");
  assert.equal(store.findGraph(repo.key, "s")?.id, "g2");
  assert.equal(store.findGraph(repo.key, "s", "missing"), undefined);
  store.appendGraphEvent(graph, "decision", { taskId: "a", decision: "retry" });
  assert.equal(store.listGraphEvents("g", "decision").length, 1);
  assert.deepEqual(store.listGraphEvents("g2", "decision"), []);
  assert.throws(() => store.updateTask("g", "missing", "done"), /not found/);
});
