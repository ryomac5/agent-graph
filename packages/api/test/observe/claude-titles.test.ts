import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedger, project } from "../../../core/src/ledger/index.ts";
import type { FactInput } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../../src/observe/claude/index.ts";
import { fileReadMetrics } from "../../src/observe/files.ts";
import { observeClaudeHistories } from "../../src/service/claude-reader.ts";
import { openObservationService } from "../../src/service/index.ts";
import { claudeConversationId, claudeLocationEventId } from "../../src/observe/claude/context.ts";

const TS = "2026-10-06T10:00:00.000Z";
const createTitle = (aiTitle: string) => JSON.stringify({ type: "ai-title", aiTitle, sessionId: "session" });
const createMessage = (uuid: string) => JSON.stringify({ type: "user", uuid, timestamp: TS,
  sessionId: "session", cwd: "/fictional/project", message: { role: "user", content: "Fictional body." } });

for (const titleFirst of [true, false]) {
  test(`新しいファイルでは会話を作成してから題名を更新する（題名が先頭: ${titleFirst}）`, t => {
    const directory = mkdtempSync(join(tmpdir(), "agent-graph-claude-title-order-"));
    const path = join(directory, "session.jsonl");
    const ledger = openLedger(":memory:");
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const rows = [createTitle("Title"), createMessage("first")];
    writeFileSync(path, (titleFirst ? rows : rows.reverse()).join("\n") + "\n");
    observeClaudeFile(ledger, path, { observedTs: TS });
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(facts.filter(fact => fact.kind.startsWith("conversation.")).map(fact => fact.kind),
      ["conversation.created", "conversation.updated"]);
    assert.equal(project(facts).conversations[0].ai_title, "Title");
  });
}

for (const withTitle of [true, false]) {
  test(`既読末尾の題名を一度だけ補完し、再起動後も全体を読み直さない（題名: ${withTitle}）`, t => {
    const directory = mkdtempSync(join(tmpdir(), "agent-graph-claude-titles-"));
    const path = join(directory, "session.jsonl");
    const database = join(directory, "ledger.sqlite");
    let ledger = openLedger(database);
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const content = [createMessage("first"),
      ...(withTitle ? [createTitle("Old"), "{bad-json}", createTitle("Last"), createTitle(" ")] : []),
      createMessage("last")].join("\n") + "\n";
    writeFileSync(path, content);
    // 旧版が末尾まで観測した台帳を再現する。題名以外の事実と cursor は残す。
    const seed = openLedger(":memory:");
    const inputs: FactInput[] = [];
    const observed = observeClaudeFile({ ...seed, append(input) {
      if (!(input.kind === "conversation.updated" && input.payload.ai_title)) inputs.push(input);
      return seed.append(input);
    } }, path, { observedTs: TS });
    for (const input of inputs) ledger.append(input);
    seed.close();
    assert.equal(observed.cursor.offset, Buffer.byteLength(content));
    const before = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const messages = before.filter(fact => fact.kind.startsWith("message"));
    const checkpoints = new Map([[path, observed.cursor]]);
    const observe = () => observeClaudeHistories(ledger, directory, ledger.readSince(0, Number.MAX_SAFE_INTEGER),
      undefined, [path], checkpoints, cwd => ({ cwd }));
    const bytes = fileReadMetrics.contentBytes;
    const first = observe();
    assert.equal(first[0].lines.length, 0);
    assert.deepEqual(first[0].conflicts, []);
    assert.ok(fileReadMetrics.contentBytes > bytes);
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(facts.filter(fact => fact.kind.startsWith("message")), messages);
    assert.equal(project(facts).conversations[0].ai_title, withTitle ? "Last" : null);
    const marker = facts.find(fact => fact.source_event_id.endsWith(":ai-title-backfill"));
    assert.ok(marker);
    assert.equal(marker.cursor, null);
    // 場所の補完と同じく、試行の印はプロセスを跨いで残る。
    ledger.close();
    ledger = openLedger(database);
    checkpoints.clear();
    const afterFirst = fileReadMetrics.contentBytes;
    assert.equal(observe()[0].lines.length, 0);
    assert.equal(fileReadMetrics.contentBytes, afterFirst);
    assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
    // 題名なしで補完を終えても、その後に追記された題名は通常の観測で取り込む。
    appendFileSync(path, createTitle("New") + "\n");
    assert.equal(observe()[0].lines.length, 1);
    assert.equal(fileReadMetrics.contentBytes - afterFirst, Buffer.byteLength(createTitle("New") + "\n"));
    assert.equal(project(ledger.readSince(0, Number.MAX_SAFE_INTEGER)).conversations[0].ai_title, "New");
  });
}

test("場所の補完済みでファイルに変更がない会話も、サービスの走査で題名を補完する", t => {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-claude-title-service-"));
  const projects = join(directory, ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  const path = join(projects, "session.jsonl");
  const database = join(directory, "ledger.sqlite");
  writeFileSync(path, [createTitle("Old"), createTitle("Last"), createMessage("last")].join("\n") + "\n");
  const seed = openLedger(database);
  // 題名を読まなかった旧版の台帳を作り、場所の補完済みの印も残す。
  observeClaudeFile({ ...seed, append(input) {
    if (input.kind === "conversation.updated" && input.payload.ai_title) return { status: "duplicate", seq: 0, fact_id: "skipped-title" };
    return seed.append(input);
  } }, path, { observedTs: TS });
  const id = claudeConversationId(path);
  seed.append({ source: "transcript-claude", source_event_id: claudeLocationEventId(id), source_ts: TS,
    confidence: "confirmed", kind: "conversation.updated", subject: `conversation:${id}`, payload: {} });
  const before = seed.readSince(0, Number.MAX_SAFE_INTEGER);
  seed.close();
  const options = { dbPath: database, env: { ...process.env, HOME: directory,
    XDG_STATE_HOME: join(directory, "state"), XDG_CONFIG_HOME: join(directory, "config"),
    CLAUDE_CONFIG_DIR: join(directory, ".claude"), CODEX_HOME: join(directory, ".codex") } };
  let service = openObservationService(options);
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  const bytes = fileReadMetrics.contentBytes;
  assert.equal(service.ingestOnce().appended, 3);
  assert.equal(fileReadMetrics.contentBytes - bytes, Buffer.byteLength([createTitle("Old"), createTitle("Last"), createMessage("last")].join("\n") + "\n"));
  const facts = service.ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(facts.slice(0, before.length), before);
  assert.equal(project(facts).conversations[0].ai_title, "Last");
  service.close();
  service = openObservationService(options);
  const afterFirst = fileReadMetrics.contentBytes;
  assert.equal(service.ingestOnce().appended, 0);
  assert.equal(fileReadMetrics.contentBytes, afterFirst);
  assert.deepEqual(service.ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
});
