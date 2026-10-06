import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { openLedger, project } from "../../../core/src/ledger/index.ts";
import { observeCodex, observeCodexFile } from "../../src/observe/codex/index.ts";

const OBSERVED = "2026-10-08T00:00:00.000Z";
const samples = fileURLToPath(new URL("../samples/", import.meta.url));
function createFixture(t: TestContext, sample: string) {
  const home = mkdtempSync(join(tmpdir(), "codex-observe-"));
  const directory = join(home, "sessions", "2026", "10", "06");
  mkdirSync(directory, { recursive: true });
  cpSync(join(samples, sample), directory, { recursive: true });
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(home, { recursive: true, force: true }); });
  const options = { codexHome: home, observedTs: OBSERVED };
  return { home, directory, ledger, options,
    read: () => ledger.readSince(0, Number.MAX_SAFE_INTEGER),
    observe: () => observeCodex(ledger, options) };
}

test("S6: 共有ホストの会話、長いターン、承認待ち、子の先行通知を分離する", (t) => {
  const f = createFixture(t, "S6");
  assert.ok(f.observe().every((result) => result.status === "appended"));
  const facts = f.read();
  const view = project(facts);
  assert.equal(view.conversations.length, 3);
  assert.equal(view.runs.length, 3);
  assert.equal(view.relations.length, 1);
  assert.equal(view.relations[0].type, "delegated");
  assert.equal(view.relations[0].confidence, "confirmed");
  assert.equal(view.runs.filter((run) => run.state === "idle").length, 2);
  assert.equal(view.runs.filter((run) => run.state === "running").length, 1);
  assert.ok(facts.some((fact) => fact.kind === "run.state_changed" && fact.payload?.state === "waiting_approval"));
  const childStart = facts.find((fact) => fact.kind === "run.state_changed" && fact.source_ts === "2026-10-06T11:14:00.000Z")!;
  const relation = facts.find((fact) => fact.kind === "relation.created")!;
  assert.ok(childStart.seq < relation.seq);
  assert.equal(relation.payload?.evidence && typeof relation.payload.evidence === "object"
    && !Array.isArray(relation.payload.evidence) && relation.payload.evidence.item_id, "fiction-spawn");
  assert.equal(view.unsupported_observations.length, 0);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
  assert.deepEqual(f.read(), facts);
});

test("S7: exec の paginated 本文を無人会話へ取り込み、作業・名前を作らない", (t) => {
  const f = createFixture(t, "S7");
  f.observe();
  const view = project(f.read());
  assert.equal(view.conversations[0].type, "unattended");
  assert.equal(view.tasks.length, 0);
  assert.equal(view.aliases.length, 0);
  assert.equal(view.messages.length, 2);
  assert.ok(view.messages.every((message) => message.body_state === "stored"));
  assert.equal(view.runs[0].state, "idle");
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
});

test("S9: 内側の作成時刻、legacy、メタのみの paginated、未知形式", (t) => {
  const f = createFixture(t, "S9");
  f.observe();
  const facts = f.read();
  const created = facts.filter((fact) => fact.kind === "conversation.created");
  assert.equal(created.find((fact) => fact.payload?.native_id === "fiction-paginated")?.source_ts, "2026-10-06T11:18:02.900Z");
  assert.equal(created.find((fact) => fact.payload?.native_id === "fiction-legacy")?.source_ts, "2026-10-06T11:10:38.894Z");
  const view = project(facts);
  assert.ok(view.conversations.some((conversation) => conversation.history_format === "legacy"));
  const unavailable = view.messages.find((message) => message.body_state === "unavailable")!;
  assert.ok(unavailable);
  assert.equal(unavailable.body, undefined);
  assert.equal(view.message_memberships.filter((membership) => membership.message_id === unavailable.id).length, 1);
  assert.equal(view.unsupported_observations[0].format_name, "future");
  assert.equal(view.unsupported_observations[0].count, 1);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
  assert.deepEqual(f.read(), facts);
});

test("同じファイルを再読しても増えず、追記と未完行は差分だけになる", (t) => {
  const f = createFixture(t, "S7");
  f.observe();
  const before = f.read();
  const path = join(f.directory, "rollout-exec.jsonl");
  const row = JSON.stringify({ timestamp: "2026-10-07T01:29:00.000Z", type: "response_item",
    payload: { type: "message", id: "fiction-new", role: "user", content: [{ type: "input_text", text: "追加の架空本文" }] } });
  const split = Buffer.from(row).indexOf(Buffer.from("架空")) + 1;
  const bytes = Buffer.from(row);
  appendFileSync(path, bytes.subarray(0, split));
  f.observe();
  assert.deepEqual(f.read(), before);
  appendFileSync(path, Buffer.concat([bytes.subarray(split), Buffer.from("\n")]));
  const appended = f.observe().filter((result) => result.status === "appended");
  assert.equal(appended.length, 2);
  const after = f.read();
  assert.equal(after.length, before.length + 2);
  const cursor = JSON.parse(after.at(-1)!.cursor!);
  assert.equal(cursor.offset, Buffer.byteLength(readFileSync(join(samples, "S7/rollout-exec.jsonl"))));
  assert.match(cursor.hash, /^[a-f0-9]{64}$/);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
});

test("S6: archive だけが終了根拠となり、復帰は新しい世代になる", (t) => {
  const f = createFixture(t, "S6");
  f.observe();
  const before = f.read();
  const live = join(f.directory, "rollout-shared-parent.jsonl");
  const archive = join(f.home, "archived_sessions", "rollout-shared-parent.jsonl");
  mkdirSync(join(f.home, "archived_sessions"));
  renameSync(live, archive);
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 1);
  const ended = project(f.read()).runs.find((run) => run.generation === 1 && run.state === "ended")!;
  assert.deepEqual(ended.end_evidence, { kind: "archived", location: "archived_sessions" });
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
  renameSync(archive, live);
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 1);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
  appendFileSync(live, JSON.stringify({ timestamp: "2026-10-07T13:00:00.000Z", type: "event_msg",
    payload: { type: "task_started", turn_id: "resumed-turn" } }) + "\n");
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 1);
  const view = project(f.read());
  assert.equal(view.runs.find((run) => run.generation === 2)?.state, "running");
  assert.equal(view.runs.find((run) => run.id === ended.id)?.state, "ended");
  assert.deepEqual(f.read().slice(0, before.length), before);
  renameSync(live, archive);
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 1);
  assert.equal(project(f.read()).runs.find((run) => run.generation === 2)?.state, "ended");
});

test("sessions と archive に同じ rollout が共存しても、三度の走査で世代が増えない", (t) => {
  const f = createFixture(t, "S7");
  const live = join(f.directory, "rollout-exec.jsonl");
  const archive = join(f.home, "archived_sessions", "rollout-exec.jsonl");
  mkdirSync(join(f.home, "archived_sessions"));
  cpSync(live, archive);
  assert.ok(f.observe().some((result) => result.status === "appended"));
  const before = f.read();
  assert.equal(before.filter((fact) => fact.kind === "run.created").length, 1);
  assert.equal(project(before).runs[0].state, "ended");
  for (let scan = 0; scan < 2; scan += 1) {
    const results = f.observe();
    assert.ok(results.length > 0);
    assert.ok(results.every((result) => result.status === "duplicate"));
    assert.ok(observeCodexFile(f.ledger, live, f.options).every((result) => result.status === "duplicate"));
    assert.deepEqual(f.read(), before);
  }
  // archive がなくなってから、残った sessions のファイルを復帰と判定する。
  renameSync(archive, join(f.home, "rollout-exec.jsonl"));
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 1);
  assert.equal(project(f.read()).runs.filter((run) => run.generation === 2).length, 1);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
});

test("未知行と不正 JSON は未対応として追記し、再読は増殖しない", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-exec.jsonl");
  appendFileSync(path, '{"timestamp":"2026-10-07T02:00:00.000Z","type":"future_row"}\n{broken}\n');
  f.observe();
  assert.equal(f.read().filter((fact) => fact.kind === "observation.unsupported").length, 2);
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
});

test("子のメタの parent_thread_id は確定辺の代わりにしない", (t) => {
  const f = createFixture(t, "S6");
  const path = join(f.directory, "rollout-child.jsonl");
  writeFileSync(path, JSON.stringify({ timestamp: "2026-10-07T00:00:00.000Z", type: "session_meta", payload: {
    id: "fiction-child", timestamp: "2026-10-06T11:14:00.000Z", source: { subAgent: { thread_spawn: { parent_thread_id: "fiction-parent" } } },
    parent_thread_id: "fiction-parent", history_mode: "legacy", cli_version: "0.160.1" } }) + "\n");
  observeCodexFile(f.ledger, path, f.options);
  assert.equal(project(f.read()).relations.length, 0);
  const hint = f.read().find((fact) => fact.kind === "run.updated");
  assert.deepEqual(hint?.payload, { last_evidence: { kind: "metadata_parent_hint", parent_thread_id: "fiction-parent" } });
  f.observe();
  assert.equal(project(f.read()).relations.length, 1);
  assert.equal(project(f.read()).relations[0].confidence, "confirmed");
});

test("未知スレッドの先行事実を残し、遅れて届くメタの内側の時刻を保持する", (t) => {
  const f = createFixture(t, "S6");
  const parent = join(f.directory, "rollout-shared-parent.jsonl");
  observeCodexFile(f.ledger, parent, f.options);
  const before = f.read();
  const child = join(f.directory, "rollout-delayed-child.jsonl");
  writeFileSync(child, JSON.stringify({ timestamp: "2026-10-07T00:00:00.000Z", type: "session_meta", payload: {
    id: "fiction-child", timestamp: "2026-10-06T11:13:00.000Z", source: "exec", history_mode: "legacy", cli_version: "0.160.1" } }) + "\n");
  observeCodexFile(f.ledger, child, f.options);
  assert.deepEqual(f.read().slice(0, before.length), before);
  assert.ok(f.read().some((fact) => fact.kind === "conversation.corrected" && fact.confidence === "confirmed"
    && fact.payload?.native_id === "fiction-child" && fact.source_ts === "2026-10-06T11:13:00.000Z"));
  assert.equal(project(f.read()).conversations.find((conversation) => conversation.native_id === "fiction-child")?.type, "unattended");
  assert.ok(observeCodexFile(f.ledger, child, f.options).every((result) => result.status === "duplicate"));
});

test("メタのみの paginated へ本文を追記したら取得不能の印を解消する", (t) => {
  const f = createFixture(t, "S9");
  const path = join(f.directory, "rollout-paginated.jsonl");
  observeCodexFile(f.ledger, path, f.options);
  assert.equal(project(f.read()).messages[0].body_state, "unavailable");
  appendFileSync(path, JSON.stringify({ timestamp: "2026-10-06T11:25:00.000Z", type: "response_item",
    payload: { type: "message", id: "fiction-paged-body", role: "user", content: [{ type: "input_text", text: "A later fictional message." }] } }) + "\n");
  observeCodexFile(f.ledger, path, f.options);
  const view = project(f.read());
  assert.equal(view.messages.filter((message) => message.body_state === "unavailable").length, 0);
  assert.equal(view.messages.filter((message) => message.body_state === "stored").length, 1);
  assert.ok(observeCodexFile(f.ledger, path, f.options).every((result) => result.status === "duplicate"));
});

test("wait と closeAgent と未完の spawnAgent は親子の確定根拠にしない", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-exec.jsonl");
  for (const [tool, status] of [["wait", "completed"], ["closeAgent", "completed"], ["spawnAgent", "inProgress"]]) {
    appendFileSync(path, JSON.stringify({ timestamp: "2026-10-07T01:30:00.000Z", method: "item/completed",
      params: { threadId: "fiction-exec", item: { type: "collabAgentToolCall", id: `fiction-${tool}`, tool, status,
        senderThreadId: "fiction-exec", receiverThreadIds: ["fiction-child"] } } }) + "\n");
  }
  f.observe();
  assert.equal(project(f.read()).relations.length, 0);
});

test("子の archive と復帰後、親側の通知はファイル位置に依存せず現在の世代へ結ぶ", (t) => {
  const f = createFixture(t, "S6");
  const child = join(f.directory, "rollout-child.jsonl");
  const archive = join(f.home, "archived_sessions", "rollout-child.jsonl");
  const meta = { timestamp: OBSERVED, type: "session_meta", payload: {
    id: "fiction-child", timestamp: "2026-10-06T11:14:00.000Z", source: "exec",
    parent_thread_id: "fiction-parent", history_mode: "legacy" } };
  writeFileSync(child, JSON.stringify(meta) + "\n" + JSON.stringify({ timestamp: "2026-10-07T00:00:00.000Z", type: "turn_context", payload: { padding: "x".repeat(10_000) } }) + "\n");
  f.observe();
  mkdirSync(join(f.home, "archived_sessions"));
  renameSync(child, archive);
  f.observe();
  // 親の再読では、archive にある子の新しい世代を作らない。
  assert.equal(f.observe().filter((result) => result.status === "appended").length, 0);
  assert.equal(project(f.read()).runs.filter((run) => run.conversation_id?.includes("fiction-child")).length, 1);
  renameSync(archive, child);
  f.observe();
  const resumed = project(f.read()).runs.find((run) => run.generation === 2)!;
  assert.ok(resumed);
  const hint = f.read().findLast((fact) => fact.kind === "run.updated");
  assert.equal(hint?.subject, `run:${resumed.id}`);
  const parent = join(f.directory, "rollout-shared-parent.jsonl");
  const parentOffset = Buffer.byteLength(readFileSync(parent));
  assert.ok(parentOffset < Buffer.byteLength(readFileSync(child)));
  appendFileSync(parent, JSON.stringify({ timestamp: "2026-10-08T01:00:00.000Z", method: "turn/started",
    params: { threadId: "fiction-child", turnId: "fiction-resumed-child" } }) + "\n");
  f.observe();
  const state = f.read().findLast((fact) => fact.kind === "run.state_changed" && fact.source_ts === "2026-10-08T01:00:00.000Z");
  assert.equal(state?.subject, `run:${resumed.id}`);
  assert.equal(project(f.read()).runs.find((run) => run.id === resumed.id)?.state, "running");
  assert.equal(project(f.read()).runs.find((run) => run.conversation_id === resumed.conversation_id && run.generation === 1)?.state, "ended");
  assert.ok(f.observe().every((result) => result.status === "duplicate"));
});

test("20 ファイル × 100 行を二度走査しても台帳は各走査で一度だけ読む", (t) => {
  const FILE_COUNT = 20;
  const LINE_COUNT = 100;
  const f = createFixture(t, "S7");
  const home = join(f.home, "scale");
  const directory = join(home, "sessions");
  mkdirSync(directory, { recursive: true });
  for (let file = 0; file < FILE_COUNT; file += 1) {
    const lines = [JSON.stringify({ timestamp: OBSERVED, type: "session_meta", payload: {
      id: `fiction-scale-${file}`, timestamp: OBSERVED, source: "exec", history_mode: "legacy" } })];
    for (let line = 1; line < LINE_COUNT; line += 1) {
      lines.push(JSON.stringify({ timestamp: OBSERVED, type: "event_msg", payload: {
        type: line % 2 ? "task_started" : "task_complete", turn_id: `fiction-turn-${line}` } }));
    }
    writeFileSync(join(directory, `rollout-scale-${file}.jsonl`), lines.join("\n") + "\n");
  }
  let reads = 0;
  const ledger = { ...f.ledger, readSince(seq: number, limit: number) {
    reads += 1;
    return f.ledger.readSince(seq, limit);
  } };
  const expectedFacts = FILE_COUNT * (LINE_COUNT + 1);
  for (let scan = 0; scan < 2; scan += 1) {
    const results = observeCodex(ledger, { ...f.options, codexHome: home });
    assert.equal(reads, scan + 1);
    assert.equal(results.length, scan === 0 ? expectedFacts : FILE_COUNT * LINE_COUNT);
    assert.ok(results.every((result) => result.status === (scan === 0 ? "appended" : "duplicate")));
  }
  assert.equal(f.read().length, expectedFacts);
});
