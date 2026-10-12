import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeContent } from "../../src/ledger/projections/claude-content.ts";
import { openLedger, readLedgerDatabase, applyIncremental, rebuild, project, createNativeId } from "../../src/ledger/index.ts";
import { forgetRunnerProjection } from "../../src/ledger/projections/storage.ts";
import { searchLedger } from "../../src/ledger/search.ts";
import { initializeSchema } from "../../src/ledger/schema.ts";

const wrap = (body: string, id = "d49b") => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;
const normalize = (body: string) => normalizeClaudeContent({ provider: "claude", role: "user", body });

for (const [input, expected] of [
  [`\n\n${wrap("本文")}\n\n`, "本文"],
  [wrap("本文\n\n\n次の段落"), "本文\n\n\n次の段落"],
  ['<pasted_content id="a">\n本文\n</pasted_content>', "本文"],
  [`${wrap("一つ目", "a")}\n\n${wrap("二つ目", "b")}`, "一つ目\n\n二つ目"],
  [`包みの外\n${wrap("中身")}\n続き`, "包みの外\n中身\n続き"],
  ['例: <pasted_content id="a">本文</pasted_content id="a">', '例: <pasted_content id="a">本文</pasted_content id="a">'],
  ['<pasted_content id="a">\n本文\n</pasted_content id="b">', '<pasted_content id="a">\n本文\n</pasted_content id="b">'],
  ['<pasted_content id="a">\n未完', '<pasted_content id="a">\n未完'],
  [`\`\`\`xml\n${wrap("タグの例")}\n\`\`\``, `\`\`\`xml\n${wrap("タグの例")}\n\`\`\``],
  ['説明: <system-reminder>例</system-reminder>', '説明: <system-reminder>例</system-reminder>'],
  ['<system-reminder>自動</system-reminder>\n\n本当の依頼', '本当の依頼'],
]) test(`包みの処理: ${input.slice(0, 45)}`, () => assert.equal(normalize(input).body, expected));

for (const tag of ["system-reminder", "task-notification"]) {
  test(`${tag} だけの発言を通知にする`, () => {
    assert.deepEqual(normalize(`<${tag}>自動の挿入</${tag}>`), { body: "", role: "notification", content_normalized: true });
  });
}

test("子の報告を user から分け、包みと定型の注意書きを残さない", () => {
  assert.deepEqual(normalize('Another Claude session sent a message:\n<agent-message from="a4dc">\n[Subagent hand-back] The text below is the final report. The report follows:\n  作業が完了しました。\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session ...'),
    { role: "agent_report", body: "作業が完了しました。", content_normalized: true });
});

test("queued_command の peer の報告にも通常の子の報告と同じ正規化を使う", () => {
  const body = '<agent-message from="child">\n  子の報告\n</agent-message>';
  const peer = normalizeClaudeContent({ provider: "claude", role: "agent_report", body });
  assert.deepEqual(peer, { role: "agent_report", body: "子の報告", content_normalized: true });
  assert.deepEqual(peer, normalize(`Another Claude session sent a message:\n${body}`));
});

test("テキストブロックだけを正規化し、画像と道具の結果と他の provider は保つ", () => {
  const image = { type: "image", source: { data: "sample" } };
  const tool = { type: "tool_result", content: wrap("道具の結果") };
  const body = [{ type: "text", text: wrap("依頼") }, image, tool];
  assert.deepEqual(normalizeClaudeContent({ provider: "claude", role: "user", body }).body,
    [{ type: "text", text: "依頼" }, image, tool]);
  assert.deepEqual(normalizeClaudeContent({ provider: "codex", role: "user", body }), {});
  assert.deepEqual(normalizeClaudeContent({ provider: "claude", role: "assistant", body }), {});
});

test("投影の更新と旧版の再構築で本文・excerpt・仮名・検索を同じ規則で直す", t => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const db = readLedgerDatabase(ledger);
  const ts = "2026-10-12T00:00:00Z";
  ledger.append({ source: "transcript-claude", source_event_id: "conversation", source_ts: ts, confidence: "confirmed",
    kind: "conversation.created", subject: "conversation:c", payload: { provider: "claude", native_id: "c", origin: "observed", type: "interactive", history_format: "jsonl" } });
  const bodies = ['<system-reminder>自動挿入</system-reminder>',
    'Another Claude session sent a message:\n<agent-message from="child">報告本文</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.', wrap("検索対象の依頼。次の文。")];
  bodies.forEach((body, index) => {
    const id = `m${index}`;
    ledger.append({ source: "transcript-claude", source_event_id: id, source_ts: ts, confidence: "confirmed", kind: "message.created", subject: `message:${id}`,
      payload: { provider: "claude", native_id: id, version: 1, role: "user", body_state: "stored", body } });
    ledger.append({ source: "transcript-claude", source_event_id: `membership${index}`, source_ts: ts, confidence: "confirmed", kind: "message_membership.created", subject: `message_membership:${id}`,
      payload: { message_id: id, conversation_id: "c", active: true } });
  });
  const facts = ledger.readSince(0, 100);
  const projected = project(facts);
  assert.equal(projected.conversations[0].first_request_excerpt, "検索対象の依頼。");
  assert.equal(projected.conversations[0].name, "検索対象の依頼。");
  assert.deepEqual(project([...facts].reverse()), projected);
  const verify = () => {
    const row = db.prepare("SELECT name, first_request_excerpt FROM conversations").get()!;
    assert.equal(row.name, "検索対象の依頼。");
    assert.equal(row.first_request_excerpt, row.name);
    const message = JSON.parse(String(db.prepare("SELECT data FROM projection_records WHERE projection = 'messages' AND entity_id = ?").get(createNativeId("claude", "m2"))!.data));
    assert.equal(message.body, "検索対象の依頼。次の文。");
    assert.equal(db.prepare("SELECT content_normalized FROM messages WHERE id = ?").get(message.id)!.content_normalized, 1);
    assert.equal(searchLedger(db, { query: "pasted_content" }).total, 0);
    assert.equal(searchLedger(db, { query: "other Claude session" }).total, 0);
    assert.equal(searchLedger(db, { query: "自動挿入" }).total, 0);
    assert.equal(searchLedger(db, { query: "検索対象" }).total, 1);
    assert.equal(searchLedger(db, { query: "報告本文" }).total, 1);
  };
  const state = applyIncremental(db, 0); verify();
  rebuild(db); verify();
  db.exec("ALTER TABLE messages DROP COLUMN content_normalized; UPDATE schema_version SET version = 13; UPDATE runner_projection_version SET version = 9; UPDATE conversations SET name = 'old', first_request_excerpt = 'old'; UPDATE search_documents SET body = 'pasted_content'");
  initializeSchema(db);
  forgetRunnerProjection(db);
  assert.equal(applyIncremental(db, state.last_seq).generation, state.generation + 2);
  verify();
  assert.deepEqual(ledger.readSince(0, 100), facts);
});

test("追記された本文も差分投影で正規化し、excerpt と検索へ反映する", t => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const db = readLedgerDatabase(ledger);
  const ts = "2026-10-12T00:00:00Z";
  ledger.append({ source: "transcript-claude", source_event_id: "c", source_ts: ts, confidence: "confirmed", kind: "conversation.created", subject: "conversation:c",
    payload: { provider: "claude", native_id: "c", origin: "observed", type: "interactive", history_format: "jsonl" } });
  const state = applyIncremental(db, 0);
  ledger.append({ source: "transcript-claude", source_event_id: "m", source_ts: ts, confidence: "confirmed", kind: "message.created", subject: "message:m",
    payload: { provider: "claude", native_id: "m", version: 1, role: "user", body: wrap("追記された依頼。"), body_state: "stored" } });
  ledger.append({ source: "transcript-claude", source_event_id: "mm", source_ts: ts, confidence: "confirmed", kind: "message_membership.created", subject: "message_membership:mm",
    payload: { message_id: "m", conversation_id: "c", active: true } });
  applyIncremental(db, state.last_seq);
  assert.equal(db.prepare("SELECT first_request_excerpt FROM conversations").get()!.first_request_excerpt, "追記された依頼。");
  assert.equal(searchLedger(db, { query: "pasted_content" }).total, 0);
  assert.equal(searchLedger(db, { query: "追記された依頼" }).total, 1);
});
