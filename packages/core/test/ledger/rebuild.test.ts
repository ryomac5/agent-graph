import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { applyIncremental, createFactId, openLedger, project, PROJECTION_TABLES, rebuild } from "../../src/ledger/index.ts";
import type { Fact, FactInput } from "../../src/ledger/index.ts";

const SAMPLES = new URL("../samples/", import.meta.url);
const SHUFFLE_REPETITIONS = 8;

function openTestLedger(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "ledger-rebuild-"));
  const path = join(directory, "ledger.sqlite");
  const writer = openLedger(path, { storageScope: "full_diff" });
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); writer.close(); rmSync(directory, { recursive: true }); });
  return { writer, database };
}

function readTables(database: DatabaseSync) {
  return Object.fromEntries(PROJECTION_TABLES.map((table) => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row })),
  ]));
}

function shuffleInputs<T>(inputs: readonly T[], seed: number): T[] {
  const shuffled = [...inputs];
  let state = seed;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function convertInputs(facts: Fact[]): FactInput[] {
  const ids = new Map(facts.map((fact) => [fact.fact_id, createFactId(fact.source, fact.source_event_id)]));
  return facts.map((fact) => ({ ...fact, supersedes: fact.supersedes && (ids.get(fact.supersedes) ?? fact.supersedes) } as FactInput));
}

for (const sample of readdirSync(SAMPLES, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  test(`${sample.name}: 再送・順序・全件再構築と差分反映の不変性`, (t) => {
    const root = new URL(`${sample.name}/`, SAMPLES);
    const facts = JSON.parse(readFileSync(new URL("facts.json", root), "utf8")) as Fact[];
    const expected = JSON.parse(readFileSync(new URL("expected.json", root), "utf8"));
    const original = JSON.stringify(facts);
    const projected = project(facts);
    assert.deepEqual(project([...facts, ...facts]), projected);
    for (const key of Object.keys(expected) as (keyof typeof projected)[]) assert.deepEqual(projected[key], expected[key]);
    assert.equal(JSON.stringify(facts), original);
    const inputs = convertInputs(facts);
    const { writer, database } = openTestLedger(t);
    for (const input of inputs) assert.equal(writer.append(input).status, "appended");
    const stored = writer.readSince(0, Number.MAX_SAFE_INTEGER);
    for (const input of inputs) assert.equal(writer.append(input).status, "duplicate");
    assert.deepEqual(writer.readSince(0, Number.MAX_SAFE_INTEGER), stored);
    assert.deepEqual(rebuild(database), { generation: 1, last_seq: inputs.length });
    const tables = readTables(database);
    assert.deepEqual(rebuild(database), { generation: 2, last_seq: inputs.length });
    assert.deepEqual(readTables(database), tables);

    for (let seed = 0; seed < SHUFFLE_REPETITIONS; seed += 1) {
      const reorderedFacts = (seed === 0 ? [...facts].reverse() : shuffleInputs(facts, seed))
        .map((fact, index) => ({ ...fact, seq: index + 1, observed_ts: "2040-01-01T00:00:00Z" }));
      assert.deepEqual(project(reorderedFacts), projected);
      const reordered = seed === 0 ? [...inputs].reverse() : shuffleInputs(inputs, seed);
      const incremental = openTestLedger(t);
      let cursor = 0;
      for (const input of reordered) {
        incremental.writer.append(input);
        const state = applyIncremental(incremental.database, cursor);
        assert.equal(state.generation, 0);
        cursor = state.last_seq;
      }
      assert.deepEqual(project(incremental.writer.readSince(0, Number.MAX_SAFE_INTEGER)), project(stored));
      assert.deepEqual(readTables(incremental.database), tables);
      assert.deepEqual(applyIncremental(incremental.database, 0), { generation: 0, last_seq: inputs.length });
      assert.deepEqual(readTables(incremental.database), tables);
      rebuild(incremental.database);
      assert.deepEqual(readTables(incremental.database), tables);
    }
    for (let split = 0; split <= inputs.length; split += 1) {
      const batched = openTestLedger(t);
      for (const input of inputs.slice(0, split)) batched.writer.append(input);
      const state = rebuild(batched.database);
      assert.deepEqual(state, { generation: 1, last_seq: split });
      for (const input of inputs.slice(split)) batched.writer.append(input);
      assert.deepEqual(applyIncremental(batched.database, state.last_seq), {
        generation: 1, last_seq: inputs.length,
      });
      assert.deepEqual(readTables(batched.database), tables);
      assert.deepEqual(applyIncremental(batched.database, state.last_seq), {
        generation: 1, last_seq: inputs.length,
      });
      assert.deepEqual(readTables(batched.database), tables);
    }
    assert.equal(JSON.stringify(facts), original);
  });
}

const TS = "2026-01-01T00:00:00Z";
const BASE = { source: "host-codex", source_ts: TS, confidence: "confirmed" } as const;
const ALL_ENTITIES: FactInput[] = [
  { ...BASE, source_event_id: "task", kind: "task.created", subject: "task:t", payload: { name: "Project-1", purpose: "Work", project: "Project", state: "active" } },
  { ...BASE, source_event_id: "conversation", kind: "conversation.created", subject: "conversation:c", payload: { provider: "codex", native_id: "native", origin: "managed", type: "interactive", history_format: "jsonl", task_id: "t" } },
  { ...BASE, source_event_id: "relation", kind: "relation.created", subject: "relation:rel", payload: { type: "continued", from_id: "c", to_id: "parent", evidence: { observed: true }, confidence: "confirmed", active: true } },
  { ...BASE, source_event_id: "run", kind: "run.created", subject: "run:r", payload: { conversation_id: "c", generation: 1, state: "running" } },
  { ...BASE, source_event_id: "connection", kind: "connection.created", subject: "connection:conn", payload: { run_id: "c:1", type: "mcp", fingerprint: "process", state: "connected" } },
  { ...BASE, source_event_id: "message", kind: "message.created", subject: "message:m", payload: { provider: "codex", native_id: "native-message", version: 1, role: "user", body: { text: "Work" }, body_state: "stored", tool_output: ["ok"] } },
  { ...BASE, source_event_id: "membership", kind: "message_membership.created", subject: "message_membership:member", payload: { message_id: "m", conversation_id: "c", active: true } },
  { ...BASE, source_event_id: "delegation", kind: "delegation.created", subject: "delegation:d", payload: { request_id: "req", parent_run_id: "r", role: "worker", title: "Work", task: "Do work", accept: ["Pass"], scope: ["src"], constraints: { safe: true }, attempt: 1, state: "received" } },
  { ...BASE, source_event_id: "artifact", kind: "artifact.created", subject: "artifact:a", payload: { run_id: "r", version: 1, repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "head", patch_hash: "patch", untracked: ["file"], verification: { passed: true }, commits: ["head"], diff: "+work" } },
  { ...BASE, source_event_id: "alias", kind: "alias.created", subject: "alias:alias", payload: { entity_id: "t", kind: "legacy", name: "Old-1" } },
  { ...BASE, source_event_id: "approval", kind: "approval.created", subject: "approval:ap", payload: { run_id: "r", request_id: "approve", state: "pending", artifact_id: "a", patch_hash: "patch", available_decisions: ["accept"], request: { command: "check" } } },
  { ...BASE, source_event_id: "finding", kind: "finding.created", subject: "finding:f", payload: { artifact_id: "a", version: 1, file: "file", start_line: 1, end_line: 2, side: "new", context_hash: "context", body: "Fix", severity: "high", state: "open" } },
];

test("全実体・補助表・部分訂正・実体をまたぐ変更を保存する", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  rebuild(database);
  for (const table of PROJECTION_TABLES) assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count, 1, table);
  assert.equal(database.prepare("SELECT origin FROM conversations").get()!.origin, "managed");
  assert.equal(database.prepare("SELECT body FROM findings").get()!.body, "Fix");
  const before = readTables(database);
  for (const inputs of [[...ALL_ENTITIES].reverse(), shuffleInputs(ALL_ENTITIES, 42)]) {
    const other = openTestLedger(t);
    let cursor = 0;
    for (const input of inputs) {
      other.writer.append(input);
      cursor = applyIncremental(other.database, cursor).last_seq;
    }
    assert.deepEqual(readTables(other.database), before);
  }
  const cursor = ALL_ENTITIES.length;
  writer.append({ ...BASE, source_event_id: "correct-task", source_ts: "2026-01-02T00:00:00Z", kind: "task.corrected", subject: "task:t", supersedes: createFactId(BASE.source, "task"), payload: { name: "Corrected" } });
  writer.append({ ...BASE, source_event_id: "artifact-next", source_ts: "2026-01-02T00:00:00Z", kind: "artifact.version_created", subject: "artifact:a2", payload: { ...ALL_ENTITIES.find((input) => input.kind === "artifact.created")!.payload, run_id: "r", version: 2, repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "next", patch_hash: "changed", untracked: [] } });
  applyIncremental(database, cursor);
  const changed = readTables(database);
  assert.notDeepEqual(changed, before);
  assert.equal(database.prepare("SELECT name FROM tasks").get()!.name, "Corrected");
  assert.equal(database.prepare("SELECT purpose FROM tasks").get()!.purpose, "Work");
  assert.equal(database.prepare("SELECT state FROM approvals").get()!.state, "stale");
  rebuild(database);
  assert.deepEqual(readTables(database), changed);
});

test("差分は不変の行に書かず、識別の訂正で古い投影を取り除く", (t) => {
  const { writer, database } = openTestLedger(t);
  writer.append(ALL_ENTITIES[0]);
  writer.append(ALL_ENTITIES[1]);
  rebuild(database);
  database.exec("CREATE TRIGGER keep_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'unchanged row'); END");
  writer.append({ ...BASE, source_event_id: "identity-correction", source_ts: "2026-01-02T00:00:00Z", kind: "conversation.corrected", subject: "conversation:c", supersedes: createFactId(BASE.source, "conversation"), payload: { native_id: "new-native" } });
  assert.deepEqual(applyIncremental(database, 2), { generation: 1, last_seq: 3 });
  assert.deepEqual(database.prepare("SELECT id FROM conversations").all().map((row) => row.id), ['["codex","new-native"]']);
  assert.deepEqual(applyIncremental(database, 3), { generation: 1, last_seq: 3 });
  assert.deepEqual(applyIncremental(database, 0), { generation: 1, last_seq: 3 });
});

test("発言だけの訂正でも所属の識別を更新し、実行だけの変更でも承認を失効させる", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  const state = rebuild(database);
  const conversation = '["codex","native"]';
  writer.append({ ...BASE, source_event_id: "message-identity", source_ts: "2026-01-02T00:00:00Z",
    kind: "message.corrected", subject: "message:m", supersedes: createFactId(BASE.source, "message"),
    payload: { native_id: "corrected-message" } });
  writer.append({ ...BASE, source_event_id: "restart", source_ts: "2026-01-02T00:00:00Z",
    kind: "run.state_changed", subject: "run:r", payload: { state: "unknown", reason: "restart" } });
  applyIncremental(database, state.last_seq);
  const message = '["codex","corrected-message"]';
  assert.deepEqual(database.prepare("SELECT id FROM messages").all().map((row) => row.id), [message]);
  assert.deepEqual(database.prepare("SELECT id, message_id, conversation_id FROM message_memberships").all()
    .map((row) => ({ ...row })), [{ id: JSON.stringify([message, conversation]), message_id: message, conversation_id: conversation }]);
  assert.equal(database.prepare("SELECT state FROM approvals").get()!.state, "expired");
  const updated = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), updated);
});

test("全件再構築は投影表の欠落と余分な行を直し、事実を変更しない", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  rebuild(database);
  const expected = readTables(database);
  const facts = writer.readSince(0, Number.MAX_SAFE_INTEGER);
  database.exec("DELETE FROM messages");
  database.exec("INSERT INTO tasks (id, name) VALUES ('orphan', 'Orphan')");
  assert.deepEqual(rebuild(database), { generation: 2, last_seq: ALL_ENTITIES.length });
  assert.deepEqual(readTables(database), expected);
  assert.deepEqual(writer.readSince(0, Number.MAX_SAFE_INTEGER), facts);
});

test("差分反映の途中で失敗しても全表とカーソルを戻し、同じ範囲を再試行できる", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  const state = rebuild(database);
  const before = readTables(database);
  writer.append({ ...BASE, source_event_id: "task-update", source_ts: "2026-01-02T00:00:00Z",
    kind: "task.updated", subject: "task:t", payload: { purpose: "Updated work" } });
  writer.append({ ...BASE, source_event_id: "approval-answer", source_ts: "2026-01-02T00:00:00Z",
    kind: "approval.answered", subject: "approval:ap", payload: { decision: "accept" } });
  database.exec("CREATE TRIGGER reject_approval BEFORE INSERT ON approvals BEGIN SELECT RAISE(ABORT, 'failure'); END");
  assert.throws(() => applyIncremental(database, state.last_seq), /failure/);
  assert.deepEqual(readTables(database), before);
  assert.deepEqual({ ...database.prepare("SELECT generation, last_seq FROM projection_state").get() }, state);
  assert.equal(writer.readSince(0, Number.MAX_SAFE_INTEGER).length, ALL_ENTITIES.length + 2);
  database.exec("DROP TRIGGER reject_approval");
  assert.deepEqual(applyIncremental(database, state.last_seq), { generation: state.generation, last_seq: ALL_ENTITIES.length + 2 });
  assert.equal(database.prepare("SELECT purpose FROM tasks").get()!.purpose, "Updated work");
  assert.equal(database.prepare("SELECT decision FROM approvals").get()!.decision, "accept");
  const updated = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), updated);
});

test("全件再構築の途中で失敗しても既存の全表と世代を戻せる", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  const state = rebuild(database);
  const before = readTables(database);
  writer.append({ ...BASE, source_event_id: "rebuild-task-update", source_ts: "2026-01-02T00:00:00Z",
    kind: "task.updated", subject: "task:t", payload: { purpose: "Updated work" } });
  const facts = writer.readSince(0, Number.MAX_SAFE_INTEGER);
  database.exec("CREATE TRIGGER reject_finding BEFORE INSERT ON findings BEGIN SELECT RAISE(ABORT, 'rebuild failure'); END");
  assert.throws(() => rebuild(database), /rebuild failure/);
  assert.deepEqual(readTables(database), before);
  assert.deepEqual({ ...database.prepare("SELECT generation, last_seq FROM projection_state").get() }, state);
  assert.deepEqual(writer.readSince(0, Number.MAX_SAFE_INTEGER), facts);
  database.exec("DROP TRIGGER reject_finding");
  assert.deepEqual(rebuild(database), { generation: state.generation + 1, last_seq: facts.length });
  assert.equal(database.prepare("SELECT purpose FROM tasks").get()!.purpose, "Updated work");
  const rebuilt = readTables(database);
  assert.deepEqual(applyIncremental(database, state.last_seq), { generation: state.generation + 1, last_seq: facts.length });
  assert.deepEqual(readTables(database), rebuilt);
});

test("空の台帳・再開・カーソルの検証・失敗時の原子性", (t) => {
  const { writer, database } = openTestLedger(t);
  assert.deepEqual(applyIncremental(database, 0), { generation: 0, last_seq: 0 });
  assert.deepEqual(rebuild(database), { generation: 1, last_seq: 0 });
  for (const cursor of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1]) {
    assert.throws(() => applyIncremental(database, cursor), RangeError);
  }
  writer.append(ALL_ENTITIES[0]);
  database.exec("CREATE TRIGGER reject_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'failure'); END");
  assert.throws(() => rebuild(database), /failure/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()!.count, 0);
  assert.deepEqual({ ...database.prepare("SELECT generation, last_seq FROM projection_state").get() }, { generation: 1, last_seq: 0 });
  database.exec("DROP TRIGGER reject_task");
  const path = database.location()!;
  const reopened = new DatabaseSync(path);
  try {
    assert.deepEqual(applyIncremental(reopened, 0), { generation: 1, last_seq: 1 });
    assert.equal(reopened.prepare("SELECT name FROM tasks").get()!.name, "Project-1");
  } finally { reopened.close(); }
});
