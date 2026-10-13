import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { applyIncremental, createNativeId, openLedger, project, readLedgerDatabase, type JsonValue, type Ledger } from "../../../core/src/ledger/index.ts";
import { searchLedger } from "../../../core/src/ledger/search.ts";
import { CLAUDE_INTERNAL_MESSAGE_FLAGS } from "../../../core/src/ledger/claude-message-flags.ts";
import { observeClaudeFile, CLAUDE_MESSAGE_FLAGS_VERSION, CLAUDE_QUEUED_COMMANDS_VERSION } from "../../src/observe/claude/index.ts";
import { observeClaudeContext } from "../../src/observe/claude/context.ts";
import { readAppendOnlyFile } from "../../src/observe/files.ts";
import { openObservationService } from "../../src/service/index.ts";
import { ProjectionFeed } from "../../src/service/projection-feed.ts";
import { SendWatch } from "../../src/service/send-watch.ts";

const TS = "2026-10-13T04:07:50.000Z";
const CONVERSATION = createNativeId("claude", "session");
const SAMPLE = readFileSync(new URL("../samples/claude-message-flags.jsonl", import.meta.url), "utf8");
const ROWS = SAMPLE.trim().split("\n").map(line => JSON.parse(line) as Record<string, JsonValue>);
const INTERNAL_IDS = ["summary", "meta", "transcript"].map(id => createNativeId("claude", id));
const RETAINED_META = [
  { id: "handback", role: "agent_report", query: "Synthetic handback result" },
  { id: "coordinator", role: "notification", query: "Synthetic coordinator instruction" },
  { id: "notification", role: "notification", query: "Synthetic completion notice" },
  { id: "relay", role: "notification", query: "Synthetic relayed instruction" },
];

function createFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "claude-message-flags-"));
  const directory = join(home, ".claude", "projects", "fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session.jsonl");
  const dbPath = join(home, "ledger.db");
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
  writeFileSync(path, SAMPLE);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, path, dbPath, env };
}

function assertMessages(ledger: Ledger) {
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  const projection = project(facts);
  assert.deepEqual(projection.messages.map(row => row.native_id).sort(), ["answer", "human", ...RETAINED_META.map(row => row.id)].sort());
  for (const { id, role } of RETAINED_META) {
    const message = projection.messages.find(row => row.native_id === id)!;
    assert.equal(message.role, role);
    assert.deepEqual(message.transcript_flags, { isMeta: true });
    assert.ok(projection.message_memberships.some(row => row.message_id === message.id));
  }
  assert.ok(!projection.message_memberships.some(row => INTERNAL_IDS.includes(row.message_id!)));
  assert.deepEqual(project([...facts].reverse()), projection);
  return projection;
}

function assertSearch(db: DatabaseSync) {
  for (const { id, query } of RETAINED_META) {
    const results = searchLedger(db, { query });
    assert.equal(results.total, 1, id);
    assert.equal(results.results[0].message_id, createNativeId("claude", id));
    assert.equal(results.results[0].conversation_id, CONVERSATION);
  }
  assert.equal(searchLedger(db, { query: "Synthetic injected metadata" }).total, 0);
}

// 旧読み手が旗を捨てて保存した事実と、末尾まで読み済みの cursor を再現する。
function seedOldReader(ledger: Ledger, path: string) {
  const file = readAppendOnlyFile(path);
  const cursor = { ...file.cursor, claudeQueuedCommandsVersion: CLAUDE_QUEUED_COMMANDS_VERSION };
  ledger.append({ source: "transcript-claude", source_event_id: `conversation:${CONVERSATION}`, source_ts: TS,
    kind: "conversation.created", subject: `conversation:${CONVERSATION}`, confidence: "confirmed",
    payload: { provider: "claude", native_id: "session", origin: "observed", type: "interactive", history_format: "jsonl" } });
  for (const row of ROWS.filter(row => row.type === "user" || row.type === "assistant")) {
    const id = createNativeId("claude", String(row.uuid));
    const common = { source: "transcript-claude" as const, confidence: "confirmed" as const, source_ts: String(row.timestamp) };
    ledger.append({ ...common, kind: "message.created", subject: `message:${id}`, source_event_id: `message:${id}`,
      payload: { provider: "claude", native_id: String(row.uuid), version: 1, role: String(row.type),
        body: (row.message as Record<string, JsonValue>).content, body_state: "stored" } });
    const membership = JSON.stringify([id, CONVERSATION]);
    ledger.append({ ...common, kind: "message_membership.created", subject: `message_membership:${membership}`,
      source_event_id: `membership:${membership}`, payload: { message_id: id, conversation_id: CONVERSATION, active: true },
      cursor: JSON.stringify(cursor) });
  }
  observeClaudeContext(ledger, path, { lines: file.lines, fromStart: true });
  return cursor;
}

test("実際の圧縮行の形を読み、人の引用は残し、要約・メタ・履歴専用行を発言にしない", t => {
  const f = createFixture(t);
  const ledger = openLedger(f.dbPath);
  t.after(() => ledger.close());
  const observation = observeClaudeFile(ledger, f.path, { observedTs: TS });
  assert.deepEqual(observation.conflicts, []);
  observeClaudeContext(ledger, f.path, { lines: observation.lines, fromStart: true });
  const projection = assertMessages(ledger);
  assert.equal(projection.relations.filter(row => row.type === "compacted").length, 1);
  assert.equal(projection.runs[0].state, "idle");
  assert.equal(projection.runs[0].last_evidence_ts, "2026-10-13T04:07:51.000Z");
  assert.deepEqual(projection.conversations[0].pending_inputs ?? [], []);
  applyIncremental(readLedgerDatabase(ledger), 0);
  assertSearch(readLedgerDatabase(ledger));
  const meta = ledger.readSince(0, Number.MAX_SAFE_INTEGER).find(fact => fact.kind === "message.created" && fact.payload?.native_id === "meta")!;
  assert.ok(meta.kind === "message.created");
  assert.deepEqual(meta.payload?.transcript_flags, { isMeta: true });
  const before = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  observeClaudeFile(ledger, f.path, { cursor: observation.cursor });
  assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), before);
});

test("false の旗・子の会話・道具の結果・画像・通常の追加入力を落とさない", t => {
  const f = createFixture(t);
  const ledger = openLedger(f.dbPath);
  t.after(() => ledger.close());
  const rows = [
    { isMeta: false, isCompactSummary: false, isVisibleInTranscriptOnly: false },
    { isSidechain: true }, { queueSkipAttachments: true }, { turnCompanion: true },
    { toolEndsTurn: true, content: [{ type: "tool_result", tool_use_id: "tool", content: "Result" }] },
    { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] },
  ].map(({ content = "Actual input", ...flags }, index) => ({ type: "user", uuid: `human-${index}`,
    timestamp: TS, message: { role: "user", content }, ...flags }));
  writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  observeClaudeFile(ledger, f.path);
  assert.equal(project(ledger.readSince(0, Number.MAX_SAFE_INTEGER)).messages.length, rows.length);
});

test("未知・不正な旗でも user と assistant を保持し、未分類の記録と再送の冪等性を保つ", t => {
  const f = createFixture(t);
  const ledger = openLedger(f.dbPath);
  t.after(() => ledger.close());
  const rows = ["user", "assistant"].flatMap(role => [
    { isFutureInternal: true }, { futureBoolean: true }, { futureBoolean: false }, { isMeta: "invalid" },
  ].map((flags, index) => ({ type: role, uuid: `${role}-${index}`, timestamp: TS,
    message: { role, content: `Future flag ${role} ${index}` }, ...flags })));
  writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  observeClaudeFile(ledger, f.path);
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.equal(facts.filter(fact => fact.kind === "observation.unsupported").length, rows.length);
  assert.deepEqual(project(facts).messages.map(row => [row.native_id, row.role]).sort(), rows.map(row => [row.uuid, row.type]).sort());
  applyIncremental(readLedgerDatabase(ledger), 0);
  assert.equal(searchLedger(readLedgerDatabase(ledger), { query: "Future flag" }).total, rows.length);
  observeClaudeFile(ledger, f.path);
  assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
});

test("isMeta の assistant は残し、要約・履歴専用の旗は報告にも優先する", t => {
  const f = createFixture(t);
  const ledger = openLedger(f.dbPath);
  t.after(() => ledger.close());
  const report = ROWS.find(row => row.uuid === "handback")!;
  const rows = [
    { ...report, uuid: "compact-report", isCompactSummary: true },
    { ...report, uuid: "transcript-report", isVisibleInTranscriptOnly: true },
    { type: "assistant", uuid: "meta-answer", timestamp: TS, isMeta: true,
      message: { role: "assistant", content: "Meta assistant response" } },
  ];
  writeFileSync(f.path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  observeClaudeFile(ledger, f.path);
  assert.deepEqual(project(ledger.readSince(0, Number.MAX_SAFE_INTEGER)).messages.map(row => row.native_id), ["meta-answer"]);
  applyIncremental(readLedgerDatabase(ledger), 0);
  assert.equal(searchLedger(readLedgerDatabase(ledger), { query: "Meta assistant response" }).total, 1);
  assert.equal(searchLedger(readLedgerDatabase(ledger), { query: "Synthetic handback result" }).total, 0);
});

for (const checkpoint of ["saved", "ledger"] as const) {
  test(`API の再開で変更のない履歴を一度補完し、差分投影と再構築が一致する (${checkpoint})`, t => {
    const f = createFixture(t);
    let service = openObservationService({ ...f });
    const cursor = seedOldReader(service.ledger, f.path);
    service.catchUp();
    const db = new DatabaseSync(f.dbPath);
    const feed = new ProjectionFeed(f.dbPath, () => service.catchUp());
    t.after(() => { feed.close(); db.close(); service.close(); });
    assert.equal(feed.conversation(CONVERSATION).projection.messages.length, 9);
    if (checkpoint === "saved") db.prepare("INSERT INTO api_observation_cursors VALUES (?, ?)")
      .run(f.path, JSON.stringify({ cursor }));
    const original = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const generation = db.prepare("SELECT generation FROM projection_state").get()!.generation;
    service.close();
    service = openObservationService({ ...f });
    const report = service.ingestOnce();
    assert.equal(report.unsupported, 0);
    const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(facts.slice(0, original.length), original);
    assert.equal(facts.filter(fact => fact.kind === "message.corrected").length, 7);
    assertMessages(service.ledger);
    const patch = feed.refresh();
    assert.ok(patch && patch !== "resync");
    const scoped = feed.scopePatch(patch, new Set([CONVERSATION]));
    assert.deepEqual(scoped.changes.messages?.remove.sort(), [...INTERNAL_IDS].sort());
    assert.equal(scoped.changes.message_memberships?.remove.length, 3);
    assert.equal(feed.conversation(CONVERSATION).projection.messages.length, 6);
    const summary = feed.snapshot().projection.conversations.find(row => row.id === CONVERSATION)!;
    assert.equal(summary.message_count, 6);
    assert.equal(summary.last_message_ts, "2026-10-13T04:07:59.000Z");
    assert.equal(db.prepare("SELECT generation FROM projection_state").get()!.generation, generation);
    const saved = JSON.parse(String(db.prepare("SELECT state FROM api_observation_cursors WHERE path = ?").get(f.path)!.state));
    assert.equal(saved.cursor.claudeMessageFlagsVersion, CLAUDE_MESSAGE_FLAGS_VERSION);
    assert.equal(searchLedger(db, { query: "Synthetic compact summary" }).total, 0);
    assert.equal(searchLedger(db, { query: "real user's quotation" }).total, 1);
    assertSearch(db);
    const tables = ["messages", "message_memberships", "conversations", "runs", "search_documents", "conversation_name_candidates"];
    const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort());
    const beforeRebuild = snapshot();
    service.rebuild();
    assert.deepEqual(snapshot(), beforeRebuild);
    assertSearch(db);
    assert.equal(service.ingestOnce().appended, 0);
    service.close();
    service = openObservationService({ ...f });
    assert.equal(service.ingestOnce().appended, 0);
    assert.deepEqual(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
  });
}

test("旗の補完が途中で止まっても、旧 cursor から再開して全件訂正する", t => {
  const f = createFixture(t);
  const ledger = openLedger(f.dbPath);
  t.after(() => ledger.close());
  const cursor = seedOldReader(ledger, f.path);
  let corrections = 0;
  const interrupted = { ...ledger, append: (input: Parameters<Ledger["append"]>[0]) => {
    if (input.kind === "message.corrected" && ++corrections === 2) throw new Error("Interrupted backfill");
    return ledger.append(input);
  } };
  assert.throws(() => observeClaudeFile(interrupted, f.path, { cursor }), /Interrupted backfill/);
  assert.deepEqual(observeClaudeFile(ledger, f.path, { cursor }).conflicts, []);
  assertMessages(ledger);
  assert.equal(ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === "message.corrected").length, 7);
  const replay = observeClaudeFile(ledger, f.path, { cursor: { ...cursor, identity: "replaced" } });
  assert.deepEqual(replay.conflicts, []);
  assert.equal(ledger.readSince(0, Number.MAX_SAFE_INTEGER).filter(fact => fact.kind === "message.corrected").length, 7);
  assertMessages(ledger);
});

for (const flag of CLAUDE_INTERNAL_MESSAGE_FLAGS) {
  test(`${flag}: 同文の圧縮・内部行で送信の見張りを閉じず、実際の入力で閉じる`, t => {
    const f = createFixture(t);
    const service = openObservationService({ ...f });
    const feed = new ProjectionFeed(f.dbPath, service.catchUp);
    const watch = new SendWatch(f.dbPath);
    t.after(() => { watch.close(); feed.close(); service.close(); });
    service.ingestOnce();
    feed.refresh();
    const roots = feed.snapshot().projection.roots;
    const runs = project(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER)).runs;
    const now = Date.parse("2026-10-13T04:08:00.000Z");
    const body = "Delivery candidate";
    watch.record("delivery", CONVERSATION, body, watch.capture(CONVERSATION, now));
    const append = (uuid: string, flags: Record<string, boolean>) => {
      appendFileSync(f.path, JSON.stringify({ type: "user", uuid, timestamp: new Date(now + 1).toISOString(),
        message: { role: "user", content: body }, ...flags }) + "\n");
      service.ingestOnce();
      feed.refresh();
    };
    append("internal-delivery", { [flag]: true });
    watch.check(now + 1000);
    assert.equal(watch.list()[0].state, "pending");
    // 未読は根の状態遷移と活動時刻、作業中は run、Queued は pending_inputs を使う。
    assert.deepEqual(feed.snapshot().projection.roots, roots);
    const projection = project(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER));
    assert.deepEqual(projection.runs, runs);
    assert.deepEqual(projection.conversations[0].pending_inputs ?? [], []);
    append("real-delivery", {});
    watch.check(now + 2000);
    assert.equal(watch.history(CONVERSATION)[0].state, "closed");
    assert.equal(watch.history(CONVERSATION)[0].message_id, createNativeId("claude", "real-delivery"));
  });
}
