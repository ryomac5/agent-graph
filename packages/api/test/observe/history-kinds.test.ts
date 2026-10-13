import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeId, openLedger, project } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../../src/observe/claude/index.ts";
import { observeCodexFile } from "../../src/observe/codex/index.ts";
import { classifyHistoryRow, extractHistoryKinds, findUnclassifiedKinds, HISTORY_CLASSIFICATIONS, identifyHistoryKind } from "../../src/observe/history-kinds.ts";
import type { HistoryClassification } from "../../src/observe/history-kinds.ts";

const TS = "2026-10-06T10:00:00.000Z";
const META = { type: "session_meta", timestamp: TS, payload: { id: "session", timestamp: TS, source: "cli" } };
function createSample(entry: HistoryClassification): Record<string, unknown> {
  const { provider, type, field, subtype } = entry;
  const row: Record<string, unknown> = { type, timestamp: TS, uuid: "sample" };
  const block = { type: subtype, text: "Synthetic text", thinking: "Synthetic thinking", content: "Synthetic result",
    id: "tool", name: "SyntheticTool", input: {}, tool_use_id: "tool", source: { type: "base64", media_type: "image/png", data: "" } };
  if (provider === "claude") {
    if (type === "user" || type === "assistant") row.message = { role: type, content: field ? [block] : "Synthetic text" };
    if (field.startsWith("flag.")) {
      row[field.slice("flag.".length)] = subtype === "true";
      row.message = { role: type, content: "Synthetic text" };
    }
    if (field === "subtype" && subtype !== "<missing>") row.subtype = subtype;
    if (field === "operation") { row.operation = subtype; row.content = "Synthetic input"; }
    if (field === "attachment.type") row.attachment = { ...(subtype === "<missing>" ? {} : { type: subtype }),
      prompt: "Synthetic input", commandMode: "prompt", origin: { kind: "human" }, timestamp: TS };
    if (field === "attachment.queued_command.commandMode+origin.kind") {
      const [commandMode, origin] = JSON.parse(subtype) as string[];
      row.attachment = { type: "queued_command", prompt: "Synthetic input", timestamp: TS,
        ...(commandMode === "<missing>" ? {} : { commandMode }),
        ...(origin === "<missing>" ? { humanTurn: true } : { origin: { kind: origin } }) };
    }
    if (type === "ai-title") row.aiTitle = "Synthetic title";
    if (type === "custom-title") row.customTitle = "Custom title";
    if (field === "attachment.type" && subtype === "structured_output") row.attachment = { type: subtype, data: { verdict: "approve" } };
    if (field === "message.model") row.message = { role: "assistant", model: "claude-sonnet-5", content: "Synthetic text" };
    if (type === "continued-in") row.continuedInSessionId = "continued";
  } else {
    const contentKind = field.startsWith("payload.") && field.endsWith(".content.type");
    const item: Record<string, unknown> = { type: contentKind ? field.split(".")[1] : subtype, id: "sample" };
    if (["message", "agentMessage", "userMessage", "agent_message"].includes(String(item.type))) {
      Object.assign(item, { role: item.type === "userMessage" ? "user" : "assistant",
        content: contentKind ? [block] : item.type === "message" ? [{ type: "output_text", text: "Synthetic text" }] : "Synthetic text" });
    }
    if (item.type === "collabAgentToolCall") Object.assign(item, {
      tool: "spawnAgent", status: "completed", senderThreadId: "session", receiverThreadIds: ["child"],
    });
    if (item.type === "function_call") Object.assign(item, { name: "synthetic_tool", arguments: "{}", call_id: "call" });
    if (item.type === "custom_tool_call") Object.assign(item, { name: "synthetic_tool", input: "Synthetic input", call_id: "call" });
    if (String(item.type).endsWith("_output")) Object.assign(item, { output: "Synthetic result", call_id: "call" });
    if (item.type === "reasoning") Object.assign(item, { summary: [], encrypted_content: "Synthetic encrypted data" });
    if (type === "legacy_meta") return { id: "session", timestamp: TS, source: "cli" };
    if (type === "session_meta") return META;
    if (type === "turn_context") row.payload = { model: "synthetic-model", effort: "high" };
    if (type === "message") Object.assign(row, { role: "user", content: [{ type: "input_text", text: "Synthetic text" }] });
    if (type === "state") { delete row.type; row.record_type = "state"; }
    if (type.includes("/")) { delete row.type; row.method = type; row.params = { threadId: "session", turnId: "turn", status: { type: "idle" } }; }
    if (field === "params.item.type") row.params = { threadId: "session", item };
    if (field.startsWith("payload.")) row.payload = type === "event_msg" ? { type: subtype, turn_id: "turn" } : item;
    if (field === "payload.item_started.item.type" || field === "payload.item_completed.item.type") {
      row.payload = { type: field.split(".")[1], item: { type: subtype, id: "sample" } };
      if (subtype === "SubAgentActivity") row.payload = { type: field.split(".")[1], thread_id: "session",
        item: { type: subtype, id: "call", kind: "started", agent_thread_id: "child", agent_path: "/root/review" } };
    }
    if (field === "payload.function_call.name") row.payload = { type: "function_call", name: subtype, arguments: "{}", call_id: "call" };
  }
  return row;
}
const expectedKinds: Record<string, string> = {
  "custom-title": "conversation.updated", "structured-output": "message.created", spawn: "message.created", "subagent-activity": "relation.created",
  message: "message.created", title: "conversation.updated", relation: "relation.created", queue: "conversation.input_queue_changed",
  "queued-command-user": "message.created", "queued-command-report": "message.created", "queued-command-legacy-user": "message.created", meta: "conversation.created", model: "run.updated", turn: "run.state_changed", delegation: "relation.created",
};
for (const entry of HISTORY_CLASSIFICATIONS) {
  test(`分類と読み手の一致: ${identifyHistoryKind(entry)}`, t => {
    const directory = mkdtempSync(join(tmpdir(), "history-kinds-"));
    const ledger = openLedger(":memory:");
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "rollout-session.jsonl");
    const observe = () => entry.provider === "claude" ? observeClaudeFile(ledger, path, { observedTs: TS })
      : observeCodexFile(ledger, path, { codexHome: directory, observedTs: TS });
    const seed = entry.provider === "claude" ? { type: "user", uuid: "seed", timestamp: TS, message: { role: "user", content: "Synthetic seed" } } : META;
    const sample = createSample(entry);
    assert.ok(extractHistoryKinds(entry.provider, sample).some(kind => identifyHistoryKind(kind) === identifyHistoryKind(entry)));
    if (entry.handler === "meta") writeFileSync(path, JSON.stringify(sample) + "\n");
    else {
      writeFileSync(path, JSON.stringify(seed) + "\n");
      observe();
      appendFileSync(path, JSON.stringify(sample) + "\n");
    }
    const before = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    observe();
    const after = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(after.slice(0, before.length), before);
    const added = after.slice(before.length);
    if (entry.action === "ingest") assert.ok(added.some(fact => fact.kind === expectedKinds[entry.handler]), JSON.stringify(added));
    else assert.deepEqual(added, []);
    if (entry.handler.startsWith("queued-command-")) {
      const message = added.find(fact => fact.kind === "message.created")!;
      assert.equal(message.payload?.role, entry.handler === "queued-command-report" ? "agent_report" : "user");
    }
    assert.ok(!added.some(fact => fact.kind === "observation.unsupported" && String(fact.payload?.reason).includes("Unclassified")));
    observe();
    assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), after);
  });
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: 未知の副種別を記録し、既知の発言と再読の結果を保つ`, t => {
    const directory = mkdtempSync(join(tmpdir(), "history-unknown-"));
    const ledger = openLedger(":memory:");
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "rollout-session.jsonl");
    const rows = provider === "claude" ? [
      { type: "attachment", attachment: { type: "future_attachment" } },
      { type: "user", uuid: "future", message: { content: [{ type: "future_block", text: "Synthetic" }] } },
      { type: "queue-operation", operation: "future_operation" },
      { type: "attachment", attachment: { type: "queued_command", commandMode: "future_mode", origin: { kind: "human" } } },
      { type: "attachment", attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "future_origin" } } },
    ] : [META, { type: "event_msg", payload: { type: "future_event" } },
      { type: "event_msg", payload: { type: "item_started", item: { type: "FutureItem" } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "FutureItem" } } },
      { type: "response_item", payload: { type: "message", content: [{ type: "future_block", text: "Synthetic" }] } }];
    writeFileSync(path, rows.map(row => JSON.stringify({ timestamp: TS, ...row })).join("\n") + "\n");
    const observe = () => provider === "claude" ? observeClaudeFile(ledger, path, { observedTs: TS })
      : observeCodexFile(ledger, path, { codexHome: directory, observedTs: TS });
    observe();
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const notices = facts.filter(fact => fact.kind === "observation.unsupported" && String(fact.payload?.reason).includes("Unclassified history kinds"));
    assert.equal(notices.length, provider === "claude" ? 5 : 4);
    assert.equal(facts.filter(fact => fact.kind === "message.created").length, 1);
    observe();
    assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
  });
}

test("分類表に重複鍵や理由のない行がない", () => {
  assert.equal(new Set(HISTORY_CLASSIFICATIONS.map(identifyHistoryKind)).size, HISTORY_CLASSIFICATIONS.length);
  assert.ok(HISTORY_CLASSIFICATIONS.every(entry => entry.reason.trim()));
});

test("除外は既知の非発言の旗に限り、isMeta と未知の旗は発言として取り込む", () => {
  const row = { type: "user", message: { content: "Actual input" } };
  assert.equal(classifyHistoryRow("claude", { ...row, isMeta: true, isCompactSummary: false, isSidechain: true })?.handler, "message");
  assert.equal(classifyHistoryRow("claude", { ...row, isCompactSummary: true, isVisibleInTranscriptOnly: true })?.action, "ignore");
  assert.equal(classifyHistoryRow("claude", { ...row, isFutureInternal: true })?.handler, "message");
  assert.equal(classifyHistoryRow("claude", { ...row, isFutureInternal: true, isCompactSummary: true })?.action, "ignore");
  assert.equal(findUnclassifiedKinds("claude", { ...row, isFutureInternal: true })[0].field, "flag.isFutureInternal");
});

for (const origin of ["coordinator", "peer"]) {
  for (const timestamp of ["attachment", "row", "missing", "invalid"] as const) {
    test(`commandMode のない ${origin}: ${timestamp} の時刻と子への所属`, t => {
      const directory = mkdtempSync(join(tmpdir(), "history-child-"));
      const ledger = openLedger(":memory:");
      t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
      const childDirectory = join(directory, "parent", "subagents");
      mkdirSync(childDirectory, { recursive: true });
      const path = join(childDirectory, "agent-child.jsonl");
      const row = { type: "attachment", uuid: "instruction", sessionId: "parent",
        ...(timestamp === "row" || timestamp === "attachment" ? { timestamp: TS } : {}),
        attachment: { type: "queued_command", origin: { kind: origin },
          ...(timestamp === "attachment" ? { timestamp: "2026-10-06T09:59:00.000Z" }
            : timestamp === "invalid" ? { timestamp: "invalid" } : {}),
          prompt: origin === "peer" ? "[Subagent hand-back]\nThe report follows:\n  Synthetic report" : "Synthetic instruction" } };
      const neighbor = (uuid: string) => ({ type: "user", uuid, timestamp: TS, message: { role: "user", content: "Neighbor" } });
      writeFileSync(path, [neighbor("before"), row, neighbor("after")].map(row => JSON.stringify(row)).join("\n") + "\n");
      const first = observeClaudeFile(ledger, path, { observedTs: "2026-10-07T00:00:00.000Z" });
      assert.deepEqual(first.conflicts, []);
      const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
      const notices = facts.filter(fact => fact.kind === "observation.unsupported");
      const messageId = createNativeId("claude", "instruction");
      const message = facts.find(fact => fact.kind === "message.created" && fact.subject === `message:${messageId}`);
      if (timestamp === "missing" || timestamp === "invalid") {
        assert.equal(message, undefined);
        assert.equal(notices.length, 1);
        assert.equal(notices[0].payload?.reason, "Missing or invalid queued command timestamp");
      } else {
        assert.deepEqual(notices, []);
        assert.equal(message?.source_ts, timestamp === "attachment" ? row.attachment.timestamp : TS);
        assert.equal(message?.kind === "message.created" ? message.payload?.role : undefined, origin === "peer" ? "agent_report" : "user");
        const projection = project(facts);
        assert.equal(projection.messages.find(message => message.id === messageId)?.body,
          origin === "peer" ? "Synthetic report" : "Synthetic instruction");
        assert.ok(projection.message_memberships.some(membership => membership.message_id === messageId
          && membership.conversation_id === createNativeId("claude", "agent-child")));
        assert.ok(projection.relations.some(relation => relation.from_id === createNativeId("claude", "parent")
          && relation.to_id === createNativeId("claude", "agent-child")));
        assert.deepEqual(project([...facts].reverse()), projection);
      }
      assert.deepEqual(observeClaudeFile(ledger, path, { cursor: { ...first.cursor, identity: "replay" } }).conflicts, []);
      assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
    });
  }
}

for (const provider of ["claude", "codex"] as const) {
  for (const input of ["{broken}", "null", "[]", "{}", '{"timestamp":"2026-10-06T10:00:00.000Z"}']) {
    test(`${provider}: 種類のない行 ${input} は従来の診断一件だけ`, t => {
      const directory = mkdtempSync(join(tmpdir(), "history-invalid-"));
      const ledger = openLedger(":memory:");
      t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
      const path = join(directory, "rollout-session.jsonl");
      writeFileSync(path, (provider === "codex" ? JSON.stringify(META) + "\n" : "") + input + "\n");
      const observe = () => provider === "claude" ? observeClaudeFile(ledger, path, { observedTs: TS })
        : observeCodexFile(ledger, path, { codexHome: directory, observedTs: TS });
      observe();
      const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
      const notices = facts.filter(fact => fact.kind === "observation.unsupported");
      assert.equal(notices.length, 1);
      assert.ok(!String(notices[0].payload?.reason).includes("Unclassified"));
      observe();
      assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
    });
  }
}

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: 未知の最上位の種類も未分類として記録し、従来の診断を保持する`, t => {
    const directory = mkdtempSync(join(tmpdir(), "history-unknown-root-"));
    const ledger = openLedger(":memory:");
    t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "rollout-session.jsonl");
    const unknown = { type: "future_row", timestamp: TS };
    writeFileSync(path, (provider === "codex" ? JSON.stringify(META) + "\n" : "") + JSON.stringify(unknown) + "\n");
    const observe = () => provider === "claude" ? observeClaudeFile(ledger, path, { observedTs: TS })
      : observeCodexFile(ledger, path, { codexHome: directory, observedTs: TS });
    observe();
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const notices = facts.filter(fact => fact.kind === "observation.unsupported");
    assert.equal(notices.length, 2);
    assert.equal(notices.filter(fact => String(fact.payload?.reason).startsWith("Unclassified history kinds:")).length, 1);
    assert.equal(notices.filter(fact => fact.payload?.reason === (provider === "claude" ? "Unsupported record type" : "Unsupported rollout record")).length, 1);
    observe();
    assert.deepEqual(ledger.readSince(0, Number.MAX_SAFE_INTEGER), facts);
  });
}
