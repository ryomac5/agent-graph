import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import { applyIncremental, createFactId, openLedger, project, PROJECTION_TABLES, rebuild, SCHEMA_VERSION } from "../../src/ledger/index.ts";
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

      const partitioned = openTestLedger(t);
      let partitionSeed = seed + 1;
      let position = 0;
      let partitionCursor = 0;
      while (position < reordered.length) {
        partitionSeed = (Math.imul(partitionSeed, 1664525) + 1013904223) >>> 0;
        const end = Math.min(position + 1 + partitionSeed % 5, reordered.length);
        for (const input of reordered.slice(position, end)) partitioned.writer.append(input);
        partitionCursor = applyIncremental(partitioned.database, partitionCursor).last_seq;
        const partial = readTables(partitioned.database);
        rebuild(partitioned.database);
        assert.deepEqual(readTables(partitioned.database), partial, `seed=${seed}, end=${end}`);
        position = end;
      }
      assert.deepEqual(readTables(partitioned.database), tables);
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

// 版 7 で足した列。版 6 以前の台帳を再現するときに落とす。
const VERSION_8_COLUMNS = [["conversations", "kit_name"], ["conversations", "created_ts"], ["delegations", "kit"]] as const;
const VERSION_7_COLUMNS = [["conversations", "cwd"], ["conversations", "repository_id"], ["runs", "model"], ["runs", "effort"],
  ["delegations", "repository_id"], ["delegations", "parent"], ["delegations", "provider"], ["delegations", "model"]] as const;

test("同じ subject の成果物の版付き ID への承認も到着順と区切りによらず stale になる", (t) => {
  const inputs: FactInput[] = [
    ...[1, 2].map((version): FactInput => ({
      ...BASE, source_event_id: `artifact-v${version}`, source_ts: `2026-01-0${version}T00:00:00Z`,
      kind: "artifact.version_created", subject: "artifact:a",
      payload: { run_id: "r", version, repository_id: "repo", worktree_id: "tree",
        base_sha: "base", head_sha: `head-${version}`, patch_hash: `patch-${version}`, untracked: [] },
    })),
    { ...BASE, source_event_id: "approve-v2", source_ts: "2026-01-03T00:00:00Z",
      kind: "approval.created", subject: "approval:ap",
      payload: { run_id: "r", request_id: "approve", state: "pending", artifact_id: "a@2", patch_hash: "patch-2" } },
    { ...BASE, source_event_id: "artifact-v3", source_ts: "2026-01-04T00:00:00Z",
      kind: "artifact.version_created", subject: "artifact:a",
      payload: { run_id: "r", version: 3, repository_id: "repo", worktree_id: "tree",
        base_sha: "base", head_sha: "head-3", patch_hash: "patch-3", untracked: [] } },
  ];
  for (let seed = 0; seed < SHUFFLE_REPETITIONS; seed += 1) {
    const reordered = seed === 0 ? inputs : shuffleInputs(inputs, seed);
    for (const partitioned of [false, true]) {
      const incremental = openTestLedger(t);
      const full = openTestLedger(t);
      let cursor = 0;
      let random = seed;
      for (let position = 0; position < reordered.length;) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const end = Math.min(position + (partitioned ? 1 + random % 3 : 1), reordered.length);
        for (const input of reordered.slice(position, end)) {
          incremental.writer.append(input);
          full.writer.append(input);
        }
        cursor = applyIncremental(incremental.database, cursor).last_seq;
        rebuild(full.database);
        assert.deepEqual(readTables(incremental.database), readTables(full.database),
          `seed=${seed}, partitioned=${partitioned}, end=${end}`);
        position = end;
      }
      assert.equal(incremental.database.prepare("SELECT state FROM approvals WHERE id = 'ap'").get()!.state, "stale");
    }
  }
});

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


test("固定種の任意の区切りで同一性の衝突・参照の訂正・遅着を再構築と照合する", (t) => {
  const later = { ...BASE, source_ts: "2026-01-02T00:00:00Z" };
  const inputs: FactInput[] = [
    ...ALL_ENTITIES,
    { ...ALL_ENTITIES[1], source_event_id: "conversation-peer", subject: "conversation:c2" },
    { ...ALL_ENTITIES[5], source_event_id: "message-peer", subject: "message:m2" },
    { ...BASE, kind: "message_membership.created", source_event_id: "membership-peer", subject: "message_membership:member2",
      payload: { message_id: "m2", conversation_id: "c2", active: true } },
    { ...ALL_ENTITIES[2], source_event_id: "relation-peer", subject: "relation:rel2",
      payload: { ...ALL_ENTITIES[2].payload, from_id: "c2" } } as FactInput,
    { ...ALL_ENTITIES[7], source_event_id: "delegation-peer", subject: "delegation:d2" },
    { ...ALL_ENTITIES[8], source_event_id: "artifact-peer", subject: "artifact:a-peer" },
    { ...later, source_event_id: "correct-conversation", kind: "conversation.corrected", subject: "conversation:c",
      supersedes: createFactId(BASE.source, "conversation"), payload: { native_id: "changed-native" } },
    { ...later, source_event_id: "correct-message", kind: "message.corrected", subject: "message:m",
      supersedes: createFactId(BASE.source, "message"), payload: { native_id: "changed-message" } },
    { ...later, source_event_id: "correct-membership", kind: "message_membership.corrected", subject: "message_membership:member",
      supersedes: createFactId(BASE.source, "membership"), payload: { conversation_id: "c2" } },
    { ...later, source_event_id: "correct-relation", kind: "relation.corrected", subject: "relation:rel",
      supersedes: createFactId(BASE.source, "relation"), payload: { from_id: "c2", active: false } },
    { ...later, source_event_id: "attempt", kind: "delegation.attempt_created", subject: "delegation:d",
      payload: { attempt: 2, run_id: "r2" } },
    { ...later, source_event_id: "origin-request", kind: "delegation.created", subject: "delegation:origin",
      payload: { request_id: "origin-request", origin: { provider: "codex", native_id: "changed-native" },
        role: "worker", title: "Origin", attempt: 0, state: "received" } },
    { ...later, source_event_id: "artifact-successor", kind: "artifact.version_created", subject: "artifact:next",
      payload: { ...ALL_ENTITIES[8].payload, run_id: "other-run", version: 2, previous_artifact_id: "a",
        repository_id: "repo", worktree_id: "tree", base_sha: "base", head_sha: "next", patch_hash: "next", untracked: [] } },
  ];
  for (let seed = 1; seed <= SHUFFLE_REPETITIONS; seed += 1) {
    const { writer, database } = openTestLedger(t);
    const reordered = shuffleInputs(inputs, seed);
    let cursor = 0;
    let random = seed;
    let position = 0;
    while (position < reordered.length) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const end = Math.min(position + 1 + random % 7, reordered.length);
      for (const input of reordered.slice(position, end)) writer.append(input);
      cursor = applyIncremental(database, cursor).last_seq;
      const partial = readTables(database);
      rebuild(database);
      assert.deepEqual(readTables(database), partial, `seed=${seed}, end=${end}`);
      position = end;
    }
  }
});

test("版 1 の台帳に索引を移行し、既存事実と続きの投影を保つ", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  const state = rebuild(database);
  const originalFacts = writer.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.ok(originalFacts.every((fact) => fact.schema_version === 1));
  const originalTables = readTables(database);
  // 旧版と同じ構造に戻した複製を開き、移行を実際に通す。
  const directory = mkdtempSync(join(tmpdir(), "ledger-v1-"));
  const path = join(directory, "ledger.sqlite");
  database.prepare("VACUUM INTO ?").run(path);
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE fact_projection_dependencies; DROP INDEX facts_subject_seq");
  legacy.exec("DROP TABLE conversation_name_candidates; DROP TABLE message_name_inputs; DROP INDEX membership_message; ALTER TABLE conversations DROP COLUMN name; ALTER TABLE conversations DROP COLUMN name_is_provisional; ALTER TABLE conversations DROP COLUMN first_request_excerpt");
  for (const [table, column] of [["messages", "source_ts"], ["messages", "source_event_id"], ["messages", "source"], ["messages", "confidence"],
    ["runs", "launch"], ["runs", "cwd"], ["runs", "branch"], ["approvals", "requested_ts"],
    ...VERSION_7_COLUMNS, ...VERSION_8_COLUMNS]) legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  legacy.prepare("UPDATE schema_version SET version = ?").run(1);
  legacy.close();
  const migrated = openLedger(path, { storageScope: "full_diff" });
  const projection = new DatabaseSync(path);
  t.after(() => { projection.close(); migrated.close(); rmSync(directory, { recursive: true }); });
  assert.deepEqual(migrated.readSince(0, Number.MAX_SAFE_INTEGER), originalFacts);
  assert.equal(projection.prepare("SELECT version FROM schema_version WHERE id = 1").get()!.version, SCHEMA_VERSION);
  assert.deepEqual(readTables(projection), originalTables);
  assert.deepEqual(applyIncremental(projection, state.last_seq), state);
  migrated.append({ ...BASE, source_event_id: "migration-update", source_ts: "2026-01-02T00:00:00Z",
    kind: "message.updated", subject: "message:m", payload: { native_id: "after-migration" } });
  applyIncremental(projection, state.last_seq);
  const incremental = readTables(projection);
  rebuild(projection);
  assert.deepEqual(readTables(projection), incremental);
});

test("版 4 の台帳を開くと、名前の規則を既存の発言に当て直し、依頼の抜粋を会話に載せる", (t) => {
  const { writer, database } = openTestLedger(t);
  const inputs: FactInput[] = [
    { ...BASE, source_event_id: "v4-c", kind: "conversation.created", subject: "conversation:c",
      payload: { provider: "codex", native_id: "c", origin: "observed", type: "interactive", history_format: "paginated" } },
    { ...BASE, source_event_id: "v4-u", kind: "conversation.created", subject: "conversation:u",
      payload: { provider: "codex", native_id: "u", origin: "observed", type: "unattended", history_format: "paginated" } },
    ...([["developer", "<permissions instructions>\nsandbox\n</permissions instructions>"],
      ["user", "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n# 規約\n</INSTRUCTIONS>"],
      ["user", "<task>\n会話の名前を直す。続き\n</task>"]] as const).flatMap(([role, body], index): FactInput[] => [
      { ...BASE, source_ts: new Date(Date.parse(TS) + index * 1000).toISOString(), source_event_id: `v4-m${index}`,
        kind: "message.created", subject: `message:m${index}`,
        payload: { provider: "codex", native_id: `m${index}`, version: 1, role, body, body_state: "stored" } },
      ...["c", "u"].map((conversation): FactInput => ({ ...BASE, source_event_id: `v4-${conversation}${index}`,
        kind: "message_membership.created", subject: `message_membership:${conversation}${index}`,
        payload: { message_id: `m${index}`, conversation_id: conversation, active: true } })),
    ]),
  ];
  for (const input of inputs) writer.append(input);
  rebuild(database);
  const expected = readTables(database);
  const directory = mkdtempSync(join(tmpdir(), "ledger-v4-"));
  const path = join(directory, "ledger.sqlite");
  database.prepare("VACUUM INTO ?").run(path);
  // 旧い規則で作った名前の索引と会話の名前を再現し、列を落として版 4 に戻す。
  const legacy = new DatabaseSync(path);
  legacy.exec(`UPDATE message_name_inputs SET name = 'sandbox' WHERE id = '["codex","m0"]';
    INSERT INTO conversation_name_candidates SELECT m.id, m.conversation_id, m.message_id, n.source_time, n.source_event_id, n.name, n.message_order
      FROM message_memberships m JOIN message_name_inputs n ON n.id = m.message_id WHERE n.id = '["codex","m0"]';
    UPDATE conversations SET name = '<permissions instructions>' WHERE id = '["codex","c"]';
    ALTER TABLE conversations DROP COLUMN first_request_excerpt; UPDATE schema_version SET version = 4;`);
  // 版 7 の列も落とし、版 4 から 5、6、7 を順に通す。版の更新を記録して順序も確かめる。
  for (const [table, column] of [...VERSION_7_COLUMNS, ...VERSION_8_COLUMNS]) legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  legacy.exec(`CREATE TABLE migration_steps (version INTEGER NOT NULL);
    CREATE TRIGGER record_migration AFTER UPDATE OF version ON schema_version
    BEGIN INSERT INTO migration_steps VALUES (NEW.version); END;`);
  legacy.close();
  const migrated = openLedger(path, { storageScope: "full_diff" });
  const projection = new DatabaseSync(path);
  t.after(() => { projection.close(); migrated.close(); rmSync(directory, { recursive: true }); });
  assert.equal(projection.prepare("SELECT version FROM schema_version WHERE id = 1").get()!.version, SCHEMA_VERSION);
  assert.deepEqual(projection.prepare("SELECT version FROM migration_steps ORDER BY rowid").all().map(row => row.version), [5, 6, 7, 8]);
  assert.deepEqual(projection.prepare("SELECT id, name, name_is_provisional, first_request_excerpt FROM conversations ORDER BY id").all()
    .map((row) => ({ ...row })), [
    { id: '["codex","c"]', name: "会話の名前を直す。", name_is_provisional: 1, first_request_excerpt: "会話の名前を直す。" },
    { id: '["codex","u"]', name: "会話の名前を直す。", name_is_provisional: 1, first_request_excerpt: "会話の名前を直す。" },
  ]);
  assert.deepEqual(readTables(projection), expected);
});

test("版 6 の台帳は版 7 と版 8 の移行だけを通し、会話の名前の当て直しを繰り返さない", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  writer.append({ ...BASE, source_event_id: "v5-location", kind: "conversation.updated", subject: "conversation:c",
    payload: { cwd: "/repo", repository_id: "repo" } });
  writer.append({ ...BASE, source_event_id: "v5-model", kind: "run.updated", subject: "run:r",
    payload: { model: "model-a", effort: "high", repository_id: "repo" } });
  writer.append({ ...BASE, source_event_id: "v5-assignment", kind: "delegation.attempt_created", subject: "delegation:d",
    payload: { attempt: 1, run_id: "r", assignment: { executor: "codex", model: "model-a" } } });
  rebuild(database);
  const expected = readTables(database);
  const directory = mkdtempSync(join(tmpdir(), "ledger-v5-"));
  const path = join(directory, "ledger.sqlite");
  database.prepare("VACUUM INTO ?").run(path);
  const legacy = new DatabaseSync(path);
  // 版 6 までの移行は名前の索引を作り直す。走れば消える印を索引に置き、版 7 の列だけを落とす。
  legacy.exec(`INSERT INTO message_name_inputs VALUES ('sentinel', 0, '00', 'sentinel', '00');
    UPDATE schema_version SET version = 6;`);
  for (const [table, column] of [...VERSION_7_COLUMNS, ...VERSION_8_COLUMNS]) legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  legacy.exec(`CREATE TABLE migration_steps (version INTEGER NOT NULL);
    CREATE TRIGGER record_migration AFTER UPDATE OF version ON schema_version
    BEGIN INSERT INTO migration_steps VALUES (NEW.version); END;`);
  legacy.close();
  const migrated = openLedger(path, { storageScope: "full_diff" });
  const projection = new DatabaseSync(path);
  t.after(() => { projection.close(); migrated.close(); rmSync(directory, { recursive: true }); });
  assert.equal(SCHEMA_VERSION, 8);
  assert.deepEqual(projection.prepare("SELECT version FROM migration_steps ORDER BY rowid").all().map(row => row.version), [7, 8]);
  assert.equal(projection.prepare("SELECT version FROM schema_version WHERE id = 1").get()!.version, 8);
  assert.equal(projection.prepare("SELECT count(*) AS count FROM message_name_inputs WHERE id = 'sentinel'").get()!.count, 1);
  assert.deepEqual({ ...projection.prepare("SELECT cwd, repository_id FROM conversations").get() },
    { cwd: "/repo", repository_id: "repo" });
  assert.deepEqual({ ...projection.prepare("SELECT model, effort FROM runs").get() },
    { model: "model-a", effort: "high" });
  assert.deepEqual({ ...projection.prepare("SELECT repository_id, provider, model FROM delegations").get() },
    { repository_id: "repo", provider: "codex", model: "model-a" });
  projection.exec("DELETE FROM message_name_inputs WHERE id = 'sentinel'");
  // 版 7 は列を足し、反映済みの行にも同じ規則の値を入れる。
  assert.deepEqual(readTables(projection), expected);
});

test("独立した実体の更新で無関係の投影行を削除・上書きしない", (t) => {
  const { writer, database } = openTestLedger(t);
  for (const input of ALL_ENTITIES) writer.append(input);
  writer.append({ ...ALL_ENTITIES[0], source_event_id: "other-task", subject: "task:other" });
  rebuild(database);
  database.exec(`CREATE TRIGGER keep_unrelated_task BEFORE INSERT ON tasks
    WHEN NEW.id = 'other' BEGIN SELECT RAISE(ABORT, 'unrelated insert'); END;
    CREATE TRIGGER keep_unrelated_task_delete BEFORE DELETE ON tasks
    WHEN OLD.id = 'other' BEGIN SELECT RAISE(ABORT, 'unrelated delete'); END;`);
  writer.append({ ...BASE, source_event_id: "affected-task", kind: "task.updated", subject: "task:t",
    source_ts: "2026-01-02T00:00:00Z", payload: { purpose: "Only this task" } });
  applyIncremental(database, ALL_ENTITIES.length + 1);
  assert.equal(database.prepare("SELECT purpose FROM tasks WHERE id = 't'").get()!.purpose, "Only this task");
  assert.equal(database.prepare("SELECT purpose FROM tasks WHERE id = 'other'").get()!.purpose, "Work");
});

test("別 subject と native の端点が衝突しても遅い到着で状態を巻き戻さない", (t) => {
  const { writer, database } = openTestLedger(t);
  const inputs: FactInput[] = [
    ALL_ENTITIES[1], ALL_ENTITIES[5],
    { ...ALL_ENTITIES[1], source_event_id: "conversation-alias", subject: "conversation:c2" },
    { ...ALL_ENTITIES[5], source_event_id: "message-alias", subject: "message:m2" },
    { ...BASE, source_ts: "2026-01-03T00:00:00Z", source_event_id: "new-membership",
      kind: "message_membership.created", subject: "message_membership:new",
      payload: { message_id: "m", conversation_id: "c", active: false } },
    { ...BASE, source_ts: "2026-01-03T00:00:00Z", source_event_id: "new-relation",
      kind: "relation.created", subject: "relation:new", payload: {
        type: "continued", from_id: "c", to_id: "parent", evidence: { observed: true }, confidence: "confirmed", active: false,
      } },
    { ...BASE, source_event_id: "late-membership-alias", kind: "message_membership.created", subject: "message_membership:alias",
      payload: { message_id: "m2", conversation_id: "c2", active: true } },
    { ...BASE, source_event_id: "late-relation-alias", kind: "relation.created", subject: "relation:alias", payload: {
      type: "continued", from_id: "c2", to_id: "parent", evidence: { observed: true }, confidence: "confirmed", active: true,
    } },
    { ...BASE, source_event_id: "late-membership-native", kind: "message_membership.created", subject: "message_membership:native",
      payload: { message_id: '["codex","native-message"]', conversation_id: '["codex","native"]', active: true } },
    { ...BASE, source_event_id: "late-relation-native", kind: "relation.created", subject: "relation:native", payload: {
      type: "continued", from_id: '["codex","native"]', to_id: "parent", evidence: { observed: true }, confidence: "confirmed", active: true,
    } },
  ];
  let cursor = 0;
  for (const input of inputs) {
    writer.append(input);
    cursor = applyIncremental(database, cursor).last_seq;
    const partial = readTables(database);
    rebuild(database);
    assert.deepEqual(readTables(database), partial, input.source_event_id);
  }
  assert.equal(database.prepare("SELECT active FROM message_memberships").get()!.active, 0);
  assert.equal(database.prepare("SELECT active FROM relations").get()!.active, 0);
});

test("仮名は古い発言の遅着・本文の訂正・所属の移動と無効化でも任意の区切りで一致する", (t) => {
  const inputs: FactInput[] = [
    { ...BASE, source_event_id: "name-c", kind: "conversation.created", subject: "conversation:c",
      payload: { provider: "codex", native_id: "c", origin: "managed", type: "interactive", history_format: "jsonl" } },
    { ...BASE, source_event_id: "name-d", kind: "conversation.created", subject: "conversation:d",
      payload: { provider: "codex", native_id: "d", origin: "managed", type: "interactive", history_format: "jsonl" } },
    ...[0, 1, 2, 3].flatMap((index): FactInput[] => [
      { ...BASE, source_ts: new Date(Date.parse(TS) + index * 1000).toISOString(),
        source_event_id: `name-message-${index}`, kind: "message.created", subject: `message:${index}`,
        payload: { provider: "codex", native_id: String(index), version: 1, role: "user",
          body: index === 0 ? " " : `First ${index}. Second sentence`, body_state: "stored" } },
      { ...BASE, source_event_id: `name-member-${index}`, kind: "message_membership.created",
        subject: `message_membership:${index}`, payload: { message_id: String(index), conversation_id: "c", active: true } },
    ]),
    { ...BASE, source_ts: "2026-01-02T00:00:00Z", source_event_id: "name-body", kind: "message.corrected",
      subject: "message:1", supersedes: createFactId(BASE.source, "name-message-1"), payload: { body: "" } },
    { ...BASE, source_ts: "2026-01-02T00:00:00Z", source_event_id: "name-move", kind: "message_membership.corrected",
      subject: "message_membership:2", supersedes: createFactId(BASE.source, "name-member-2"), payload: { conversation_id: "d" } },
    { ...BASE, source_ts: "2026-01-02T00:00:00Z", source_event_id: "name-inactive", kind: "message_membership.corrected",
      subject: "message_membership:3", supersedes: createFactId(BASE.source, "name-member-3"), payload: { active: false } },
  ];
  for (let seed = 0; seed < SHUFFLE_REPETITIONS; seed += 1) {
    const { writer, database } = openTestLedger(t);
    const reordered = seed === 0 ? inputs : shuffleInputs(inputs, seed);
    let cursor = 0;
    let random = seed;
    for (let position = 0; position < reordered.length;) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const end = Math.min(position + (seed === 0 ? 1 : 1 + random % 4), reordered.length);
      for (const input of reordered.slice(position, end)) writer.append(input);
      cursor = applyIncremental(database, cursor).last_seq;
      const partial = readTables(database);
      rebuild(database);
      assert.deepEqual(readTables(database), partial, `seed=${seed}, end=${end}`);
      position = end;
    }
    assert.deepEqual(database.prepare("SELECT name, name_is_provisional FROM conversations ORDER BY id").all()
      .map((row) => ({ ...row })), [
      { name: null, name_is_provisional: 0 }, { name: "First 2.", name_is_provisional: 1 },
    ]);
  }
});

test("仮名候補の同時刻の Unicode 識別子も純粋な投影と同じ順で比較する", (t) => {
  const { writer, database } = openTestLedger(t);
  writer.append({ ...BASE, source_event_id: "unicode-c", kind: "conversation.created", subject: "conversation:c",
    payload: { provider: "codex", native_id: "c", origin: "managed", type: "interactive", history_format: "jsonl" } });
  let cursor = applyIncremental(database, 0).last_seq;
  for (const id of ["\uE000", "😀"]) {
    writer.append({ ...BASE, source_event_id: id, kind: "message.created", subject: `message:${id}`,
      payload: { provider: "codex", native_id: id, version: 1, role: "user", body: id, body_state: "stored" } });
    writer.append({ ...BASE, source_event_id: `member-${id}`, kind: "message_membership.created",
      subject: `message_membership:${id}`, payload: { message_id: id, conversation_id: "c", active: true } });
    cursor = applyIncremental(database, cursor).last_seq;
    assert.equal(database.prepare("SELECT name FROM conversations").get()!.name,
      project(writer.readSince(0, Number.MAX_SAFE_INTEGER)).conversations[0].name);
  }
  const incremental = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
});

test("仮名候補の索引も、同じ時刻の旧い rollout の行の位置を桁数によらず数として比べる", (t) => {
  const { writer, database } = openTestLedger(t);
  writer.append({ ...BASE, source_event_id: "rollout-c", kind: "conversation.created", subject: "conversation:c",
    payload: { provider: "codex", native_id: "c", origin: "observed", type: "interactive", history_format: "legacy" } });
  let cursor = applyIncremental(database, 0).last_seq;
  for (const [offset, body] of [[104048, "後の依頼。"], [9999, "最初の依頼。"]] as const) {
    writer.append({ ...BASE, source_event_id: `message:rollout-c.jsonl:${offset}:h:1`, kind: "message.created", subject: `message:m${offset}`,
      payload: { provider: "codex", native_id: `m${offset}`, version: 1, role: "user", body, body_state: "stored" } });
    writer.append({ ...BASE, source_event_id: `member-${offset}`, kind: "message_membership.created",
      subject: `message_membership:${offset}`, payload: { message_id: `m${offset}`, conversation_id: "c", active: true } });
    cursor = applyIncremental(database, cursor).last_seq;
  }
  assert.equal(database.prepare("SELECT name FROM conversations").get()!.name, "最初の依頼。");
  const incremental = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
});

test("画面が読む発言の時刻と出所、実行の起動設定と作業ツリー、承認の要求時刻を投影の列に残す", (t) => {
  const { writer, database } = openTestLedger(t);
  const host = { source: "host-claude" as const, confidence: "confirmed" as const };
  const inputs: FactInput[] = [
    { ...host, source_event_id: "run", source_ts: "2026-01-01T00:00:00Z", kind: "run.created", subject: "run:r",
      payload: { conversation_id: "c", generation: 1, state: "starting" } },
    { ...host, source_event_id: "tree", source_ts: "2026-01-01T00:00:01Z", kind: "run.updated", subject: "run:r",
      payload: { generation: 1, cwd: "/repo/tree", branch: "main", worktree_id: "w" } },
    { ...host, source_event_id: "launch", source_ts: "2026-01-01T00:00:02Z", kind: "run.updated", subject: "run:r",
      // runner の supervisor と同じく、起動の設定は run.updated の launch に載る。
      payload: { generation: 1, launch: { cwd: "/repo/tree", model: { model: "m", effort: "high" } } } } as FactInput,
    { ...host, source_event_id: "message", source_ts: "2026-01-01T00:00:03Z", kind: "message.created", subject: "message:m",
      payload: { provider: "claude", native_id: "m", version: 1, role: "assistant", body: "Hello", body_state: "stored" } },
    { ...host, source_event_id: "approval", source_ts: "2026-01-01T00:00:04Z", kind: "approval.created", subject: "approval:a",
      payload: { run_id: "r", request_id: "q", state: "pending" } },
  ];
  // 差分の投影と全件の再構築が、同じ列の値を出す。
  for (const input of inputs) { writer.append(input); applyIncremental(database, Number(database.prepare("SELECT last_seq FROM projection_state").get()!.last_seq)); }
  const incremental = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
  const run = incremental.runs.find((row) => row.id === "c:1")!;
  assert.deepEqual(JSON.parse(String(run.launch)), { cwd: "/repo/tree", model: { effort: "high", model: "m" } });
  assert.equal(run.cwd, "/repo/tree");
  assert.equal(run.branch, "main");
  const message = incremental.messages[0];
  assert.equal(message.source_ts, "2026-01-01T00:00:03Z");
  assert.equal(message.source, "host-claude");
  assert.equal(message.confidence, "confirmed");
  assert.equal(incremental.approvals[0].requested_ts, "2026-01-01T00:00:04Z");
});
