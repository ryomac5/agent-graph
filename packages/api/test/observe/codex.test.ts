import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { openLedger, project } from "../../../core/src/ledger/index.ts";
import { observeCodex, observeCodexFile } from "../../src/observe/codex/index.ts";
import { openObservationService } from "../../src/service/index.ts";

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

test("既知の補助行は ID がない場合も未対応にならない", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-known.jsonl");
  const items = ["reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output",
    "commandExecution", "fileChange", "web_search_call", "tool_search_call", "tool_search_output", "compaction"];
  const events = ["token_count", "agent_reasoning", "user_message", "agent_message", "exec_command_begin", "exec_command_end",
    "exec_command_output_delta", "item_started", "item_completed", "context_compacted", "warning", "error", "thread_settings_applied"];
  const records = ["turn_context", "compacted", "token_usage_record", "world_state", "inter_agent_communication_metadata"];
  const methods = ["item/started", "item/agentMessage/delta", "thread/tokenUsage/updated", "serverRequest/resolved",
    "thread/started", "thread/settings/updated"];
  const rows = [
    ...items.map((type) => ({ type })),
    ...items.map((type) => ({ type: "response_item", payload: { type } })),
    ...items.map((type) => ({ method: "item/completed", params: { item: { type } } })),
    ...events.map((type) => ({ type: "event_msg", payload: { type } })),
    ...records.map((type) => ({ type })),
    ...methods.map((method) => ({ method })),
    { record_type: "state" },
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  assert.deepEqual(observeCodexFile(f.ledger, path, f.options), []);
  assert.deepEqual(f.read(), []);
});

test("未対応はファイル・種類・理由で集約し件数を payload に保持する", (t) => {
  const f = createFixture(t, "S7");
  const rows = [
    { timestamp: OBSERVED, type: "session_meta", payload: { id: "fiction-group", timestamp: OBSERVED } },
    { type: "future_row" }, { type: "future_row" },
    { type: "response_item", payload: { type: "future_item" } },
    { type: "response_item", payload: { type: "future_item" } },
    { type: "response_item", payload: { type: "other_future_item" } },
  ];
  const paths = ["rollout-group-a.jsonl", "rollout-group-b.jsonl"].map((name) => join(f.directory, name));
  for (const path of paths) {
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    observeCodexFile(f.ledger, path, f.options);
  }
  const facts = f.read();
  const unsupported = facts.filter((fact) => fact.kind === "observation.unsupported");
  assert.equal(unsupported.length, 6);
  assert.deepEqual(unsupported.map((fact) => (fact.payload as { count: number }).count), [2, 2, 1, 2, 2, 1]);
  for (const path of paths) observeCodexFile(f.ledger, path, f.options);
  assert.deepEqual(f.read(), facts);
  const archive = join(f.home, "archived_sessions", "rollout-group-a.jsonl");
  mkdirSync(join(f.home, "archived_sessions"));
  renameSync(paths[0], archive);
  observeCodexFile(f.ledger, archive, f.options);
  assert.deepEqual(f.read().filter((fact) => fact.kind === "observation.unsupported"), unsupported);
  appendFileSync(paths[1], JSON.stringify({ type: "future_row" }) + "\n");
  observeCodexFile(f.ledger, paths[1], f.options);
  const update = f.read().findLast((fact) => fact.kind === "observation.unsupported")!;
  assert.equal((update.payload as { count: number }).count, 3);
  assert.equal(update.supersedes, unsupported[3].fact_id);
  const after = f.read();
  observeCodexFile(f.ledger, paths[1], f.options);
  assert.deepEqual(f.read(), after);
});

test("件数の異なる sessions と archive の未対応は最大件数だけを追記する", (t) => {
  const f = createFixture(t, "S7");
  const live = join(f.directory, "rollout-unsupported.jsonl");
  const archive = join(f.home, "archived_sessions", "rollout-unsupported.jsonl");
  const row = JSON.stringify({ timestamp: OBSERVED, type: "future_row", threadId: "fiction-unsupported" }) + "\n";
  appendFileSync(live, row);
  assert.ok(f.observe().every((result) => result.status === "appended"));
  const initial = f.read().find((fact) => fact.kind === "observation.unsupported")!;
  assert.equal((initial.payload as { count: number }).count, 1);
  mkdirSync(join(f.home, "archived_sessions"));
  cpSync(live, archive);
  assert.ok(f.observe().every((result) => result.status !== "conflict"));
  assert.equal(f.read().filter((fact) => fact.kind === "observation.unsupported").length, 1);

  for (const [path, count] of [[live, 2], [archive, 3]] as const) {
    appendFileSync(path, row.repeat(count - 1));
    const previous = f.read().findLast((fact) => fact.kind === "observation.unsupported")!;
    const results = f.observe();
    assert.ok(results.every((result) => result.status !== "conflict"));
    assert.equal(results.filter((result) => result.status === "appended").length, 1);
    const facts = f.read();
    const unsupported = facts.filter((fact) => fact.kind === "observation.unsupported");
    assert.deepEqual(unsupported.map((fact) => (fact.payload as { count: number }).count),
      count === 2 ? [1, 2] : [1, 2, 3]);
    assert.equal(unsupported.at(-1)!.supersedes, previous.fact_id);
    assert.equal((unsupported.at(-1)!.payload as { count: number }).count, count);
    for (let scan = 0; scan < 2; scan += 1) {
      assert.ok(f.observe().every((result) => result.status === "duplicate"));
      for (const copy of [archive, live]) {
        assert.ok(observeCodexFile(f.ledger, copy, f.options).every((result) => result.status === "duplicate"));
      }
      assert.deepEqual(f.read(), facts);
    }
  }
});

test("legacy の先頭メタの ID を直下の発言へ引き継ぐ", (t) => {
  const f = createFixture(t, "S9");
  const path = join(f.directory, "rollout-legacy-head.jsonl");
  const rows = [
    { id: "fiction-old-thread", timestamp: "2026-10-06T10:00:00.000Z", instructions: "Fictional instructions.", git: {} },
    { type: "message", id: "fiction-old-user", role: "user", content: [{ type: "input_text", text: "Fictional input." }] },
    { type: "reasoning", id: "fiction-old-reasoning", summary: [] },
    { type: "function_call", call_id: "fiction-call", name: "fiction-tool", arguments: "{}" },
    { type: "function_call_output", call_id: "fiction-call", output: "Fictional output." },
    { type: "message", id: "fiction-old-agent", role: "assistant", content: [{ type: "output_text", text: "Fictional reply." }] },
    { record_type: "state" },
  ];
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  observeCodexFile(f.ledger, path, f.options);
  const facts = f.read();
  const view = project(facts);
  assert.equal(view.conversations[0].native_id, "fiction-old-thread");
  assert.equal(facts.find((fact) => fact.kind === "conversation.created")?.source_ts, "2026-10-06T10:00:00.000Z");
  assert.equal(view.messages.length, 2);
  assert.ok(view.message_memberships.every((membership) => membership.conversation_id === view.conversations[0].id));
  assert.equal(view.unsupported_observations.length, 0);
  observeCodexFile(f.ledger, path, f.options);
  assert.deepEqual(f.read(), facts);
});

test("legacy の ID をファイル名末尾から解決しメタの ID を優先する", (t) => {
  const f = createFixture(t, "S9");
  const id = "00000000-0000-4000-8000-000000000009";
  const path = join(f.directory, `rollout-2026-10-06T10-00-00-${id}.jsonl`);
  const message = { type: "message", id: "fiction-filename-message", role: "user", content: [] };
  writeFileSync(path, JSON.stringify(message) + "\n");
  observeCodexFile(f.ledger, path, f.options);
  assert.equal(project(f.read()).conversations[0].native_id, id);
  assert.equal(project(f.read()).message_memberships.length, 1);
  assert.equal(project(f.read()).unsupported_observations.length, 0);
  const before = f.read();
  observeCodexFile(f.ledger, path, f.options);
  assert.deepEqual(f.read(), before);
  const other = join(f.directory, `rollout-other-${id}.jsonl`);
  writeFileSync(other, JSON.stringify({ id: "fiction-meta-priority", timestamp: OBSERVED }) + "\n"
    + JSON.stringify({ ...message, id: "fiction-priority-message" }) + "\n");
  observeCodexFile(f.ledger, other, f.options);
  assert.ok(project(f.read()).conversations.some((conversation) => conversation.native_id === "fiction-meta-priority"));
});

test("ID を解決できないファイルは種類によらず一件の未対応にまとめる", (t) => {
  const f = createFixture(t, "S9");
  const path = join(f.directory, "rollout-no-thread.jsonl");
  writeFileSync(path, [
    { timestamp: OBSERVED, type: "session_meta", payload: { timestamp: OBSERVED } },
    { type: "message", id: "fiction-message", role: "user", content: [] },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
    { type: "event_msg", payload: { type: "task_started" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  observeCodexFile(f.ledger, path, f.options);
  const facts = f.read();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].kind, "observation.unsupported");
  assert.ok(facts[0].kind === "observation.unsupported");
  assert.equal(facts[0].payload?.reason, "Missing thread identifier");
  assert.equal((facts[0].payload as { count: number }).count, 4);
  observeCodexFile(f.ledger, path, f.options);
  assert.deepEqual(f.read(), facts);
});

function openFixtureService(f: ReturnType<typeof createFixture>) {
  return openObservationService({ home: f.home, dbPath: join(f.home, "service.db"),
    env: { CODEX_HOME: f.home, CLAUDE_CONFIG_DIR: join(f.home, "claude") } });
}

test("常駐の増分読み取りは未対応を 100 件から累積し、複製・再起動でも二重に数えない", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-exec.jsonl");
  const archive = join(f.home, "archived_sessions", "rollout-exec.jsonl");
  const row = JSON.stringify({ timestamp: OBSERVED, type: "future_row" }) + "\n";
  appendFileSync(path, row.repeat(100));
  mkdirSync(join(f.home, "archived_sessions"));
  cpSync(path, archive);
  let service = openFixtureService(f);
  const readUnsupported = () => service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)
    .filter((fact) => fact.kind === "observation.unsupported");
  try {
    service.ingestOnce();
    assert.deepEqual(readUnsupported().map((fact) => (fact.payload as { count: number }).count), [100]);
    appendFileSync(path, row.repeat(5));
    service.ingestOnce();
    const facts = readUnsupported();
    assert.deepEqual(facts.map((fact) => (fact.payload as { count: number }).count), [100, 105]);
    assert.equal(facts[1].supersedes, facts[0].fact_id);
    assert.ok(Number((facts[1].payload as { last_offset: number }).last_offset) > Number((facts[0].payload as { last_offset: number }).last_offset));
    assert.match(String((facts[1].payload as { last_hash: string }).last_hash), /^[a-f0-9]{64}$/);
    assert.equal(service.ingestOnce().unsupported, 0);
    assert.equal(service.ingestOnce().unsupported, 0);
  } finally { service.close(); }
  service = openFixtureService(f);
  try {
    assert.equal(service.ingestOnce().unsupported, 0);
    appendFileSync(path, row.repeat(7));
    assert.equal(service.ingestOnce().unsupported, 1);
    assert.deepEqual(readUnsupported().map((fact) => (fact.payload as { count: number }).count), [100, 105, 112]);
    assert.equal(service.ingestOnce().unsupported, 0);
    assert.equal(service.ingestOnce().unsupported, 0);
  } finally { service.close(); }
});

test("増分読み取りで種類別の offset を保ち、ID 不明の集約も累積する", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-no-id.jsonl");
  const message = JSON.stringify({ type: "message", role: "user", content: [] }) + "\n";
  writeFileSync(path, message.repeat(100));
  const service = openFixtureService(f);
  try {
    service.ingestOnce();
    appendFileSync(path, message.repeat(5));
    service.ingestOnce();
    assert.equal(service.ingestOnce().unsupported, 0);
    const missing = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)
      .filter((fact) => fact.kind === "observation.unsupported");
    assert.deepEqual(missing.map((fact) => (fact.payload as { count: number }).count), [100, 105]);
    const other = join(f.directory, "rollout-exec.jsonl");
    const row = (type: string) => JSON.stringify({ timestamp: OBSERVED, type }) + "\n";
    appendFileSync(other, row("future_a").repeat(100) + row("future_b").repeat(200));
    service.ingestOnce();
    appendFileSync(other, row("future_a").repeat(5) + row("future_b").repeat(7));
    service.ingestOnce();
    const unknown = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)
      .filter((fact) => fact.kind === "observation.unsupported" && fact.payload?.reason !== "Missing thread identifier");
    assert.deepEqual(unknown.map((fact) => (fact.payload as { count: number }).count), [100, 200, 105, 207]);
    assert.equal(service.ingestOnce().unsupported, 0);
  } finally { service.close(); }
});

test("常駐と再起動で legacy メタを優先し、旧い未対応 cursor より前の発言も取り込む", (t) => {
  const f = createFixture(t, "S7");
  const id = "00000000-0000-4000-8000-000000000019";
  for (const name of ["rollout-legacy-no-uuid.jsonl", `rollout-legacy-${id}.jsonl`]) {
    const path = join(f.directory, name);
    const rows = [
      { id: `fiction-meta-${name}`, timestamp: OBSERVED },
      ...["first", "middle", "last"].map((suffix) => ({ type: "message", id: `fiction-${name}-${suffix}`,
        role: "user", content: [{ type: "input_text", text: "Fictional message." }] })),
    ];
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  const dbPath = join(f.home, "service.db");
  const ledger = openLedger(dbPath);
  // 旧い実装が保存した最終行の cursor を再現し、履歴を消さずに補う。
  for (const name of ["rollout-legacy-no-uuid.jsonl", `rollout-legacy-${id}.jsonl`]) {
    const bytes = readFileSync(join(f.directory, name));
    const offset = bytes.lastIndexOf(10, bytes.length - 2) + 1;
    ledger.append({ source: "rollout-codex", source_event_id: `fiction-old-${name}`, kind: "observation.unsupported",
      subject: `observation:fiction-old-${name}`, source_ts: OBSERVED, confidence: "confirmed",
      cursor: JSON.stringify({ file_id: name, offset, hash: "fiction-old-hash" }),
      payload: { source_kind: "rollout-codex", reason: "Missing thread identifier", file_path: join(f.directory, name),
        format_name: "legacy", format_version: "unknown" } });
  }
  ledger.close();
  let service = openFixtureService(f);
  try {
    service.ingestOnce();
    const initial = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.equal(project(initial).messages.filter((message) => message.native_id?.startsWith("fiction-rollout-legacy")).length, 6);
    for (const name of ["rollout-legacy-no-uuid.jsonl", `rollout-legacy-${id}.jsonl`]) {
      appendFileSync(join(f.directory, name), JSON.stringify({ type: "message", id: `fiction-${name}-added`,
        role: "assistant", content: [] }) + "\n");
    }
    assert.equal(service.ingestOnce().unsupported, 0);
    assert.equal(service.ingestOnce().appended, 0);
  } finally { service.close(); }
  service = openFixtureService(f);
  try {
    assert.equal(service.ingestOnce().appended, 0);
    const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const view = project(facts);
    const legacy = view.messages.filter((message) => message.native_id?.startsWith("fiction-rollout-legacy"));
    assert.equal(legacy.length, 8);
    for (const message of legacy) {
      const membership = view.message_memberships.find((entry) => entry.message_id === message.id)!;
      const conversation = view.conversations.find((entry) => entry.id === membership.conversation_id)!;
      assert.ok(conversation.native_id?.startsWith("fiction-meta-rollout-legacy"));
    }
    assert.equal(facts.filter((fact) => fact.kind === "observation.unsupported").length, 2);
  } finally { service.close(); }
});

test("offset のない旧い集約を再起動時に全行から補い、以降は増分で数える", (t) => {
  const f = createFixture(t, "S7");
  const path = join(f.directory, "rollout-exec.jsonl");
  const row = JSON.stringify({ timestamp: OBSERVED, type: "future_row" }) + "\n";
  const offset = readFileSync(path).length;
  appendFileSync(path, row.repeat(105));
  const key = JSON.stringify(["rollout-exec.jsonl", "future_row", "unknown", "Unsupported rollout record"]);
  const ledger = openLedger(join(f.home, "service.db"));
  ledger.append({ source: "rollout-codex", source_event_id: `${key}:unsupported:100`,
    kind: "observation.unsupported", subject: `observation:codex:${key}`, source_ts: OBSERVED,
    confidence: "confirmed", cursor: JSON.stringify({ file_id: "rollout-exec.jsonl", offset, hash: "fiction-old-hash" }),
    payload: { source_kind: "rollout-codex", file_path: path, format_name: "paginated", format_version: "unknown",
      reason: "Unsupported rollout record", ...{ count: 100 } } });
  ledger.close();
  const service = openFixtureService(f);
  try {
    service.ingestOnce();
    appendFileSync(path, row.repeat(7));
    service.ingestOnce();
    const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)
      .filter((fact) => fact.kind === "observation.unsupported");
    assert.deepEqual(facts.map((fact) => (fact.payload as { count: number }).count), [100, 105, 112]);
    assert.equal(facts[1].supersedes, facts[0].fact_id);
    assert.equal(facts[2].supersedes, facts[1].fact_id);
    assert.equal(service.ingestOnce().unsupported, 0);
  } finally { service.close(); }
});
