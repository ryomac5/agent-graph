import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createNativeId, openLedger, project, rebuild } from "../../../core/src/ledger/index.ts";
import type { Fact, Ledger } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../../src/observe/claude/index.ts";
import { observeClaudeHistories } from "../../src/service/claude-reader.ts";
import { observeCodexFile } from "../../src/observe/codex/index.ts";
import { createIncrementalRolloutReader } from "../../src/service/codex-reader.ts";
import { fileReadMetrics } from "../../src/observe/files.ts";
import type { FileCursor } from "../../src/observe/files.ts";
import { openObservationService } from "../../src/service/index.ts";
import { ProjectionFeed } from "../../src/service/projection-feed.ts";

const TS = "2026-09-25T01:18:00.000Z";
const claude = readFileSync(new URL("../samples/history-details/claude.jsonl", import.meta.url), "utf8");
const codex = readFileSync(new URL("../samples/history-details/codex.jsonl", import.meta.url), "utf8");
const readFacts = (ledger: Ledger) => ledger.readSince(0, Number.MAX_SAFE_INTEGER);

test("実物形式の手動タイトル・状態を変えないモデル変更・構造化出力を既存の投影に残す", t => {
  const directory = mkdtempSync(join(tmpdir(), "history-details-"));
  const path = join(directory, "session.jsonl");
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(path, claude);
  const checkpoints = new Map<string, FileCursor>();
  const observe = () => observeClaudeHistories(ledger, directory, readFacts(ledger), undefined, [path], checkpoints);
  observe();
  const facts = readFacts(ledger);
  const projection = project(facts);
  assert.equal(projection.conversations[0].user_name, "Review the importer");
  assert.equal(projection.conversations[0].ai_title, "Automatic title");
  assert.equal(projection.runs[0].model, "claude-opus-5");
  assert.deepEqual(facts.flatMap(f => f.kind === "run.updated" && f.source_event_id.startsWith("model:") ? [f.payload?.model] : []),
    ["claude-sonnet-5", "claude-opus-5"]);
  const output = projection.messages.find(m => m.native_id === "output")!;
  assert.equal(output.role, "assistant");
  assert.equal(output.phase, "final_answer");
  assert.deepEqual(JSON.parse(String(output.body)), { verdict: "approve", comment: "The importer preserves native identifiers." });
  assert.ok(projection.message_memberships.some(m => m.message_id === output.id && m.conversation_id === projection.conversations[0].id));
  observe();
  assert.deepEqual(readFacts(ledger), facts);
  assert.deepEqual(project([...facts].reverse()), projection);
  appendFileSync(path, JSON.stringify({ type: "custom-title", customTitle: "Renamed review", sessionId: "session" }) + "\n");
  observe();
  assert.equal(project(readFacts(ledger)).conversations[0].user_name, "Renamed review");
});

for (const scenario of [
  { name: "UI で改名した後に同じ custom-title と user 行を取り込んでも会話名と根の名前を保つ",
    title: "Review the importer", expectedName: "Renamed in dashboard", expectedTitles: ["Review the importer"] },
  { name: "UI で改名した後でも新しい custom-title を会話名と根の名前に反映する",
    title: "Renamed in Claude Code", expectedName: "Renamed in Claude Code", expectedTitles: ["Review the importer", "Renamed in Claude Code"] },
]) test(scenario.name, t => {
  const directory = mkdtempSync(join(tmpdir(), "history-details-rename-"));
  const path = join(directory, "session.jsonl");
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(path, claude);
  const initial = observeClaudeFile(ledger, path, { observedTs: TS });
  assert.deepEqual(initial.conflicts, []);
  const id = createNativeId("claude", "session");
  assert.equal(project(readFacts(ledger)).conversations[0].user_name, "Review the importer");
  assert.equal(ledger.append({ source: "ui", source_event_id: "dashboard-rename", kind: "conversation.renamed",
    subject: `conversation:${id}`, source_ts: "2026-09-25T01:19:00.000Z", confidence: "confirmed",
    payload: { user_name: "Renamed in dashboard" } }).status, "appended");
  const renamed = project(readFacts(ledger));
  assert.equal(renamed.conversations[0].user_name, "Renamed in dashboard");
  assert.equal(renamed.roots[0].name, "Renamed in dashboard");
  appendFileSync(path, [
    { type: "custom-title", customTitle: scenario.title, sessionId: "session" },
    { type: "user", uuid: "request-after-rename", timestamp: "2026-09-25T01:20:00.000Z", sessionId: "session",
      message: { role: "user", content: "Continue the review." } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = observeClaudeFile(ledger, path, { cursor: initial.cursor, observedTs: "2026-09-25T01:20:00.000Z" });
  assert.deepEqual(result.conflicts, []);
  const facts = readFacts(ledger);
  const projection = project(facts);
  assert.equal(projection.conversations[0].user_name, scenario.expectedName);
  assert.equal(projection.roots[0].name, scenario.expectedName);
  assert.ok(projection.messages.some(message => message.native_id === "request-after-rename"));
  assert.deepEqual(facts.flatMap(fact => fact.kind === "conversation.updated" && fact.source === "transcript-claude"
    && fact.source_event_id.startsWith("custom-title:") ? [fact.payload?.user_name] : []), scenario.expectedTitles);
  observeClaudeFile(ledger, path, { cursor: result.cursor, observedTs: "2026-09-25T01:21:00.000Z" });
  assert.deepEqual(readFacts(ledger), facts);
});

test("Codex の起動・完了・親への連絡を分け、増分と再起動でも子の辺を一つだけ残す", t => {
  const directory = mkdtempSync(join(tmpdir(), "history-details-codex-"));
  const sessions = join(directory, "sessions");
  mkdirSync(sessions);
  const path = join(sessions, "rollout-parent.jsonl");
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const lines = codex.trimEnd().split("\n");
  writeFileSync(path, lines.slice(0, 3).join("\n") + "\n");
  let incremental = createIncrementalRolloutReader(ledger);
  const observe = () => {
    const results = observeCodexFile({ ...ledger, append: input => ledger.append(incremental.decorate(input)) }, path,
      { codexHome: directory, reader: incremental.reader, observedTs: TS });
    assert.ok(results.every(result => result.status !== "conflict"));
    incremental.commit();
  };
  observe();
  assert.equal(project(readFacts(ledger)).relations.length, 0);
  incremental = createIncrementalRolloutReader(ledger);
  appendFileSync(path, lines.slice(3, 4).join("\n") + "\n");
  observe();
  const child = createNativeId("codex", "child");
  assert.equal(project(readFacts(ledger)).runs.find(run => run.conversation_id === child)?.state, "unknown");
  appendFileSync(path, lines.slice(4).join("\n") + "\n");
  observe();
  const facts = readFacts(ledger);
  const projection = project(facts);
  assert.equal(projection.relations.length, 1);
  assert.equal(projection.relations[0].from_id, createNativeId("codex", "parent"));
  assert.equal(projection.relations[0].to_id, child);
  assert.equal(projection.relations[0].confidence, "confirmed");
  assert.equal(projection.conversations.find(c => c.id === child)?.type, "subagent");
  assert.equal(projection.runs.find(run => run.conversation_id === child)?.state, "unknown");
  assert.equal(projection.runs.find(run => run.conversation_id === createNativeId("codex", "parent"))?.model, "gpt-6-sol");
  assert.ok(facts.some(f => f.kind === "run.updated" && (f.payload?.last_evidence as { activity_kind?: string })?.activity_kind === "interacted"));
  assert.deepEqual(projection.messages[0].body, [{ type: "tool_use", id: "spawn-call", name: "spawn_agent",
    input: { task_name: "review", fork_turns: "all", message: "Review the importer." } }]);
  observe();
  incremental = createIncrementalRolloutReader(ledger);
  observe();
  assert.deepEqual(readFacts(ledger), facts);
  assert.deepEqual(project([...facts].reverse()), projection);
});

function isDetail(fact: Fact): boolean {
  return /^(custom-title:|structured-output|model:)/.test(fact.source_event_id)
    || fact.source === "rollout-codex" && (fact.subject.includes('"child"') || fact.subject.includes('function-item')
      || /:(model|activity|subagent)$/.test(fact.source_event_id) || fact.kind === "relation.created");
}

test("旧 cursor の既読範囲を一度補完し、未変更ファイルと再起動・rebuild 後の配信を保つ", t => {
  const home = mkdtempSync(join(tmpdir(), "history-details-service-"));
  const claudeDir = join(home, ".claude/projects");
  const codexDir = join(home, ".codex/sessions");
  mkdirSync(claudeDir, { recursive: true }); mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(claudeDir, "session.jsonl"), claude);
  writeFileSync(join(codexDir, "rollout-parent.jsonl"), codex);
  const dbPath = join(home, "ledger.sqlite");
  const options = { home, dbPath, env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") } };
  let service = openObservationService(options);
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  service.ingestOnce();
  const details = readFacts(service.ledger).filter(isDetail);
  service.close();
  // 旧版が候補を除外して末尾まで読んだ状態を、一時 DB だけで再現する。
  const db = new DatabaseSync(dbPath);
  for (const fact of details) db.prepare("DELETE FROM facts WHERE fact_id=?").run(fact.fact_id);
  for (const row of db.prepare("SELECT path, state FROM api_observation_cursors").all()) {
    const state = JSON.parse(String(row.state));
    delete state.cursor.claudeHistoryDetailsVersion; delete state.cursor.codexHistoryDetailsVersion;
    db.prepare("UPDATE api_observation_cursors SET state=? WHERE path=?").run(JSON.stringify(state), row.path);
  }
  rebuild(db); db.close();
  service = openObservationService(options);
  const before = readFacts(service.ledger);
  assert.ok(service.ingestOnce().appended > 0);
  const facts = readFacts(service.ledger);
  assert.deepEqual(facts.slice(0, before.length), before);
  const projection = project(facts);
  assert.equal(projection.conversations.find(c => c.provider === "claude")?.user_name, "Review the importer");
  assert.equal(projection.runs.find(r => r.conversation_id === createNativeId("claude", "session"))?.model, "claude-opus-5");
  assert.equal(projection.relations.length, 1);
  assert.equal(projection.messages.filter(m => m.native_id === "output").length, 1);
  const bytes = fileReadMetrics.contentBytes;
  assert.equal(service.ingestOnce().appended, 0);
  service.close(); service = openObservationService(options);
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(fileReadMetrics.contentBytes, bytes);
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  const snapshot = feed.conversation(createNativeId("claude", "session")).projection;
  assert.equal(snapshot.conversations[0].user_name, "Review the importer");
  assert.ok(snapshot.messages.some(m => m.native_id === "output"));
  feed.close();
  service.rebuild();
  const rebuilt = new ProjectionFeed(dbPath, service.catchUp);
  assert.deepEqual(rebuilt.conversation(createNativeId("claude", "session")).projection, snapshot);
  rebuilt.close();
  assert.deepEqual(readFacts(service.ledger), facts);
});

test("補完が中断されても cursor を進めず、構造化出力の所属を回復する", t => {
  const directory = mkdtempSync(join(tmpdir(), "history-details-interrupted-"));
  const path = join(directory, "session.jsonl");
  const ledger = openLedger(":memory:");
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(path, claude);
  const original = observeClaudeFile({ ...ledger, append: input =>
    /^(custom-title:|structured-output)/.test(input.source_event_id) ? { status: "duplicate", seq: 0, fact_id: "old-reader" } : ledger.append(input),
  }, path, { observedTs: TS });
  const cursor = { ...original.cursor, claudeHistoryDetailsVersion: undefined };
  assert.throws(() => observeClaudeFile({ ...ledger, append(input) {
    if (input.source_event_id.startsWith("structured-output-membership:")) throw new Error("Interrupted details");
    return ledger.append(input);
  } }, path, { cursor, observedTs: TS }), /Interrupted details/);
  const resumed = observeClaudeFile(ledger, path, { cursor, observedTs: TS });
  assert.deepEqual(resumed.conflicts, []);
  const projection = project(readFacts(ledger));
  assert.equal(projection.messages.filter(m => m.native_id === "output").length, 1);
  assert.ok(projection.message_memberships.some(m => m.message_id === createNativeId("claude", "output")));
});
