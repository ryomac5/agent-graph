import { USAGE_PROBE_PATH } from '../../src/usage/probe-path.ts';
import { observeClaudeContext } from '../../src/observe/claude/context.ts';
import type { Fact } from "../../../core/src/ledger/index.ts";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { applyIncremental, createNativeId, openLedger, project, readLedgerDatabase } from "../../../core/src/ledger/index.ts";
import type { FactInput, Ledger, LedgerOptions } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile, observeClaudeProjects } from "../../src/observe/claude/index.ts";
import type { ClaudeUnsupportedPayload } from "../../src/observe/claude/index.ts";

// 既存の未対応診断の識別と集約は、新しい未分類診断と分けて検証する。
function isLegacyUnsupported(fact: Fact): fact is Extract<Fact, { kind: "observation.unsupported" }> {
  return fact.kind === "observation.unsupported" && !String((fact.payload as { reason?: string } | null)?.reason).startsWith("Unclassified history kinds:");
}
const TS = "2026-10-06T10:00:00.000Z";
function createFixture(t: TestContext, options: LedgerOptions = {}): { ledger: Ledger; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-graph-claude-"));
  const ledger = openLedger(":memory:", options);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { ledger, directory };
}
function createMessage(uuid: string, content = "Fictional body.", version = "2.1.291"): string {
  return JSON.stringify({ type: "user", uuid, timestamp: TS, sessionId: "session",
    entrypoint: "cli", version, message: { role: "user", content } });
}
function readFacts(ledger: Ledger) { return ledger.readSince(0, Number.MAX_SAFE_INTEGER); }
function readNativeId(id: string): string { return (JSON.parse(id) as string[])[1]; }

function createQueuedCommand(uuid: string, kind: string | undefined = "human", commandMode = "prompt") {
  return { type: "attachment", uuid, timestamp: "2026-10-06T10:01:00.000Z", attachment: {
    type: "queued_command", prompt: "Next step", source_uuid: `source-${uuid}`, delivery_id: `delivery-${uuid}`,
    commandMode, ...(kind ? { origin: { kind } } : {}), humanTurn: true, timestamp: TS,
  } };
}

test("実物の enqueue・remove・queued_command から利用者の発言を一件だけ残す", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "midturn.jsonl");
  writeFileSync(path, [
    { type: "queue-operation", operation: "enqueue", content: "Next step", timestamp: TS },
    { type: "queue-operation", operation: "remove", content: "Next step", reason: "absorbed_mid_turn",
      commandUuid: "source-human", deliveryId: "delivery-human", timestamp: "2026-10-06T10:01:00.000Z" },
    createQueuedCommand("human"),
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const first = observeClaudeFile(ledger, path);
  const facts = readFacts(ledger);
  const projection = project(facts);
  assert.equal(facts.filter(fact => fact.kind === "message.created").length, 1);
  assert.deepEqual(projection.messages.map(row => [row.native_id, row.role, row.body, row.source_ts]),
    [["human", "user", "Next step", TS]]);
  assert.deepEqual(projection.conversations[0].pending_inputs, []);
  assert.equal(projection.message_memberships.length, 1);
  assert.deepEqual(project([...facts].reverse()), projection);
  assert.deepEqual(observeClaudeFile(ledger, path, { cursor: { ...first.cursor, identity: "replay" } }).conflicts, []);
  assert.deepEqual(readFacts(ledger), facts);
});

test("古い humanTurn を取り込み、peer は子の報告にして通知と別の起源は入れない", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "origins.jsonl");
  const peer = createQueuedCommand("peer", "peer");
  peer.attachment.prompt = '<agent-message from="child">Report</agent-message>';
  writeFileSync(path, [createQueuedCommand("legacy", undefined), peer,
    createQueuedCommand("notification", "task-notification", "task-notification"),
    createQueuedCommand("coordinator", "coordinator")].map(row => JSON.stringify(row)).join("\n") + "\n");
  observeClaudeFile(ledger, path);
  assert.deepEqual(project(readFacts(ledger)).messages.map(row => [row.native_id, row.role, row.body]),
    [["legacy", "user", "Next step"], ["peer", "agent_report", "Report"]]);
});

test("通常の user と attachment が同じ uuid を持っても一件に投影し、既存事実と衝突しない", t => {
  for (const userFirst of [false, true]) {
    const { ledger, directory } = createFixture(t);
    const path = join(directory, "duplicate.jsonl");
    const user = createMessage("shared", "Next step");
    const attachment = JSON.stringify(createQueuedCommand("shared"));
    writeFileSync(path, (userFirst ? user : attachment) + "\n");
    const first = observeClaudeFile(ledger, path);
    const original = readFacts(ledger);
    appendFileSync(path, (userFirst ? attachment : user) + "\n");
    assert.deepEqual(observeClaudeFile(ledger, path, { cursor: first.cursor }).conflicts, []);
    const facts = readFacts(ledger);
    assert.deepEqual(facts.slice(0, original.length), original);
    assert.equal(project(facts).messages.length, 1);
    assert.equal(project(facts).message_memberships.length, 1);
    assert.deepEqual(observeClaudeFile(ledger, path, { cursor: { ...first.cursor, identity: "replay" } }).conflicts, []);
    assert.deepEqual(readFacts(ledger), facts);
  }
});

test("本文が同じでも UUID が異なる再発言は消さない", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "repeated.jsonl");
  writeFileSync(path, JSON.stringify(createQueuedCommand("queued")) + "\n" + createMessage("later", "Next step") + "\n");
  observeClaudeFile(ledger, path);
  assert.equal(project(readFacts(ledger)).messages.length, 2);
});

test("待ち行列を追記し、dequeue と user の観測後も再読で衝突しない", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "queue.jsonl");
  const queue = (operation: string, content?: string) => JSON.stringify({ type: "queue-operation", operation, content, timestamp: TS });
  writeFileSync(path, `${createMessage("before")}\n${queue("enqueue", "Next step")}\n`);
  observeClaudeFile(ledger, path, { observedTs: TS });
  const readInputs = () => project(readFacts(ledger)).conversations[0].pending_inputs;
  assert.equal(readInputs()?.[0].state, "queued");
  assert.equal(readInputs()?.[0].body, "Next step");
  applyIncremental(readLedgerDatabase(ledger), 0);
  const stored = readLedgerDatabase(ledger).prepare("SELECT data FROM projection_records WHERE projection = 'conversations'").get();
  assert.equal(JSON.parse(String(stored?.data)).pending_inputs[0].state, "queued");
  appendFileSync(path, `${queue("future-operation")}\n${queue("dequeue")}\n`);
  observeClaudeFile(ledger, path, { observedTs: TS });
  assert.deepEqual(readInputs(), []);
  appendFileSync(path, `${createMessage("read", "Next step")}\n`);
  const observed = observeClaudeFile(ledger, path, { observedTs: TS });
  assert.deepEqual(readInputs(), []);
  const facts = readFacts(ledger);
  const replay = observeClaudeFile(ledger, path, { cursor: { ...observed.cursor, identity: "replaced" }, observedTs: "2026-10-07T00:00:00Z" });
  assert.equal(replay.appended, 0);
  assert.deepEqual(replay.conflicts, []);
  assert.deepEqual(readFacts(ledger), facts);
  assert.deepEqual(project([...facts].reverse()), project(facts));
});

test("user と tool_result の行は待ち行列の事実を増やさない", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "queue.jsonl");
  writeFileSync(path, JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "Read directly", timestamp: TS }) + "\n");
  observeClaudeFile(ledger, path, { observedTs: TS });
  appendFileSync(path, createMessage("read", "Read directly") + "\n");
  observeClaudeFile(ledger, path, { observedTs: TS });
appendFileSync(path, JSON.stringify({ type: "user", uuid: "tool-result", timestamp: TS,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "Large result".repeat(1000) }] } }) + "\n");
  observeClaudeFile(ledger, path, { observedTs: TS });
  assert.equal(readFacts(ledger).filter(fact => fact.kind === "conversation.input_queue_changed").length, 1);
  assert.equal(project(readFacts(ledger)).conversations[0].pending_inputs?.[0].body, "Read directly");
});

for (const sample of ["S1", "S4"]) {
  test(`${sample} の事実と投影が標本に一致し、再読込と再構築で増えない`, (t) => {
    const { ledger, directory } = createFixture(t);
    const source = new URL(`../samples/${sample}/`, import.meta.url);
    cpSync(source, directory, { recursive: true });
    const expected = JSON.parse(readFileSync(new URL("expected.json", source), "utf8"));
    for (const input of (expected.initialFacts ?? []) as FactInput[]) ledger.append(input);
    const results = observeClaudeProjects(ledger, join(directory, "projects"), { observedTs: TS });
    assert.ok(results.every((result) => result.conflicts.length === 0));
    const facts = readFacts(ledger);
    const counts: Record<string, number> = {};
    for (const fact of facts) counts[fact.kind] = (counts[fact.kind] ?? 0) + 1;
    assert.deepEqual(counts, expected.facts);
    const projection = project(facts);
    assert.deepEqual(projection.conversations.map((row) => [row.native_id, row.type, row.origin]).sort(), expected.conversations);
    assert.deepEqual(projection.messages.map((row) => row.native_id).sort(), expected.messages);
    assert.equal(projection.message_memberships.length, expected.membershipCount);
    assert.deepEqual(projection.relations.map((row) => [row.type, readNativeId(row.from_id!), readNativeId(row.to_id!)]).sort(), expected.relations);
    assert.ok(projection.relations.every((row) => row.confidence === "confirmed"));
    assert.equal(projection.tasks.length, 0);
    assert.equal(projection.runs.length, 0);
    assert.deepEqual(projection.operation_targets.slice().sort(), projection.conversations.map((row) => row.id).sort());
    observeClaudeProjects(ledger, join(directory, "projects"), { observedTs: TS });
    assert.deepEqual(readFacts(ledger), facts);
    // 無効な cursor を渡して先頭から再送しても、台帳の識別で重複しない。
    for (const result of results) {
      const replay = observeClaudeFile(ledger, result.cursor.path,
        { cursor: { ...result.cursor, identity: "replaced" }, observedTs: TS });
      assert.equal(replay.appended, 0);
      assert.equal(replay.conflicts.length, 0);
    }
    assert.deepEqual(readFacts(ledger), facts);
    assert.deepEqual(project([...facts].reverse()), projection);
    if (sample === "S4") {
      const shared = createNativeId("claude", "s4-shared");
      assert.equal(projection.messages.filter((row) => row.id === shared).length, 1);
      assert.equal(projection.message_memberships.filter((row) => row.message_id === shared).length, 3);
    }
  });
}
test("追記された発言だけを取り込み、途中の JSON 行を保留する", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, `${createMessage("first")}\n`);
  const first = observeClaudeFile(ledger, path, { observedTs: TS });
  assert.equal(first.appended, 3);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
  const second = createMessage("second");
  appendFileSync(path, second.slice(0, 30));
  const pending = observeClaudeFile(ledger, path);
  assert.equal(pending.appended, 0);
  assert.ok(pending.pendingBytes > 0);
  appendFileSync(path, `${second.slice(30)}\n`);
  assert.equal(observeClaudeFile(ledger, path, { cursor: pending.cursor }).appended, 2);
  assert.equal(readFacts(ledger).length, 5);
  writeFileSync(path, `${createMessage("first")}\n${second}\n${createMessage("third")}\n`);
  // 同じ内容の再送も別の会話を作らない。
  assert.equal(observeClaudeFile(ledger, path).appended, 2);
  assert.equal(readFacts(ledger).length, 7);
});
test("ファイルの置き換えを再読込しても既存事実を複製しない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, `${createMessage("first")}\n${createMessage("second")}\n`);
  observeClaudeFile(ledger, path);
  writeFileSync(path, `${createMessage("first")}\n`);
  const reset = observeClaudeFile(ledger, path);
  assert.equal(reset.reset, true);
  assert.equal(reset.appended, 0);
  assert.equal(readFacts(ledger).length, 5);
});
test("未知の構造・種類・JSON を未対応とし、会話を隠さず、再送を数えない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "future.jsonl");
  writeFileSync(path, [createMessage("future", "Future body.", "99.0.0"),
    JSON.stringify({ type: "future-record" }), JSON.stringify({ type: "user", uuid: "missing-body" }), "{bad-json}"].join("\n") + "\n");
  assert.equal(observeClaudeFile(ledger, path, { observedTs: TS }).appended, 7);
  const projection = project(readFacts(ledger));
  assert.equal(projection.conversations.length, 1);
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.unsupported_observations.reduce((sum, row) => sum + row.count, 0), 4);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
});
test("旧い版と新しい版の発言を構造で取り込む", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "versions.jsonl");
  const versions = ["2.1.273", "2.1.274", "2.1.275", "2.1.276", "2.1.277", "2.1.278", "2.1.279", "2.1.280", "2.1.281", "2.1.282", "2.1.283", "99.0.0", "2.1.285", "2.1.286", "2.1.287", "2.1.288", "2.1.289", "2.1.290", "2.1.291"];
  writeFileSync(path, versions.map((version) =>
    createMessage(`version-${version}`, "Versioned message.", version)).join("\n") + "\n");
  const result = observeClaudeFile(ledger, path);
  assert.deepEqual(result.conflicts, []);
  const projection = project(readFacts(ledger));
  assert.deepEqual(projection.messages.map((row) => row.native_id).sort(), versions.map((version) => `version-${version}`).sort());
  assert.deepEqual(projection.unsupported_observations, []);
});
test("実在する補助記録を無視し、後続の発言を取り込む", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "metadata.jsonl");
  const types = ["file-history-snapshot", "progress", "summary", "custom-title", "agent-name", "last-prompt", "pr-link", "system", "agent-setting", "relocated", "worktree-state", "attachment", "ai-title", "permission-mode", "mode", "atis-latch", "cost-state", "file-history-delta", "bridge-session"];
  writeFileSync(path, [...types.map((type) => JSON.stringify({ type, version: "2.1.273", timestamp: "invalid" })),
    createMessage("after-metadata")].join("\n") + "\n");
  assert.equal(observeClaudeFile(ledger, path).appended, 3);
  const projection = project(readFacts(ledger));
  assert.equal(projection.unsupported_observations.length, 0);
  assert.deepEqual(projection.messages.map((row) => row.native_id), ["after-metadata"]);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
});
test("未対応はファイル・種類・理由ごとに件数を集約し、再送と追記で増殖しない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "unsupported.jsonl");
  const unknown = JSON.stringify({ type: "future-record", version: "2.1.273" });
  const otherVersion = JSON.stringify({ type: "future-record", version: "99.0.0" });
  const subtype = JSON.stringify({ type: "system", subtype: "future-subtype" });
  writeFileSync(path, [unknown, otherVersion, subtype, subtype,
    JSON.stringify({ type: "continued-in" }), JSON.stringify({ type: "system", subtype: "compact_boundary" })].join("\n") + "\n");
  const first = observeClaudeFile(ledger, path);
  assert.equal(first.appended, 7);
  assert.deepEqual(first.conflicts, []);
  const unsupported = readFacts(ledger).filter((fact) => isLegacyUnsupported(fact));
  const payloads = unsupported.map((fact) => fact.payload as Partial<ClaudeUnsupportedPayload>);
  assert.deepEqual(payloads.map((payload) => payload.count), [2, 2, 1, 1]);
  assert.deepEqual(payloads.map((payload) => payload.record_type), ["future-record", "system", "continued-in", "system"]);
  const replay = observeClaudeFile(ledger, path, { cursor: { ...first.cursor, identity: "replay" } });
  assert.equal(replay.appended, 0);
  assert.deepEqual(replay.conflicts, []);
  appendFileSync(path, unknown + "\n");
  const added = observeClaudeFile(ledger, path);
  assert.equal(added.appended, 0);
  assert.deepEqual(added.conflicts, []);
  const replacement = path + ".new";
  writeFileSync(replacement, unknown + "\n");
  renameSync(replacement, path);
  const replaced = observeClaudeFile(ledger, path);
  assert.equal(replaced.reset, true);
  assert.equal(replaced.appended, 0);
  assert.deepEqual(replaced.conflicts, []);
  appendFileSync(path, JSON.stringify({ type: "another-future-record" }) + "\n");
  assert.equal(observeClaudeFile(ledger, path).appended, 2);
  const otherPath = join(directory, "another.jsonl");
  writeFileSync(otherPath, unknown + "\n" + otherVersion + "\n");
  assert.equal(observeClaudeFile(ledger, otherPath).appended, 3);
  assert.equal(readFacts(ledger).filter((fact) => isLegacyUnsupported(fact)).length, 6);
});
for (const includeNewGroup of [false, true]) {
  test(`保存済みの未対応が再登場しても cursor が進む（新規の組: ${includeNewGroup}）`, (t) => {
    const { ledger, directory } = createFixture(t);
    const path = join(directory, "cursor.jsonl");
    const known = JSON.stringify({ type: "system", subtype: "fictional-unknown" });
    writeFileSync(path, [known, createMessage("first")].join("\n") + "\n");
    const first = observeClaudeFile(ledger, path);
    const initialUnsupported = readFacts(ledger).filter((fact) => isLegacyUnsupported(fact));
    const addedLines = [...(includeNewGroup ? [JSON.stringify({ type: "fictional-new" })] : []),
      known, createMessage("second")];
    appendFileSync(path, addedLines.join("\n") + "\n");
    const second = observeClaudeFile(ledger, path);
    assert.equal(second.lines.length, addedLines.length);
    assert.equal(second.appended, includeNewGroup ? 4 : 2);
    assert.deepEqual(second.conflicts, []);
    assert.ok(second.cursor.offset > first.cursor.offset);
    const savedCursor = readFacts(ledger).filter((fact) => fact.cursor).at(-1)!.cursor!;
    assert.deepEqual(JSON.parse(savedCursor), second.cursor);
    assert.deepEqual(readFacts(ledger).filter((fact) => isLegacyUnsupported(fact))
      .slice(0, initialUnsupported.length), initialUnsupported);
    appendFileSync(path, createMessage("third") + "\n");
    const third = observeClaudeFile(ledger, path);
    assert.equal(third.lines.length, 1);
    assert.equal(third.appended, 2);
    assert.deepEqual(third.conflicts, []);
    assert.equal(observeClaudeFile(ledger, path).lines.length, 0);
    const projection = project(readFacts(ledger));
    assert.equal(projection.messages.length, 3);
    assert.equal(readFacts(ledger).filter((fact) => isLegacyUnsupported(fact)).length,
      includeNewGroup ? 2 : 1);
  });
}
test("既知の system subtype を取り込まず未対応にもせず、compact だけを取り込む", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "system.jsonl");
  const subtypes = ["api_error", "away_summary", "bridge_status", "informational", "local_command",
    "model_refusal_fallback", "scheduled_task_fire", "stop_hook_summary", "turn_duration"];
  writeFileSync(path, [...subtypes.map((subtype) => JSON.stringify({ type: "system", subtype })),
    JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "fictional-boundary" })].join("\n") + "\n");
  observeClaudeFile(ledger, path);
  const projection = project(readFacts(ledger));
  assert.equal(projection.unsupported_observations.length, 0);
  assert.equal(projection.relations.length, 1);
  assert.equal(projection.relations[0].type, "compacted");
});
test("未対応の集約保存前に停止しても後続の発言の cursor で未保存の行を飛ばさない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "interrupted.jsonl");
  writeFileSync(path, [JSON.stringify({ type: "fictional-unknown" }), createMessage("after-unknown"),
    JSON.stringify({ type: "fictional-other" })].join("\n") + "\n");
  const failingLedger: Ledger = {
    ...ledger,
    append(input) {
      if (input.kind === "observation.unsupported") throw new Error("Simulated interrupted aggregate");
      return ledger.append(input);
    },
  };
  assert.throws(() => observeClaudeFile(failingLedger, path), /Simulated interrupted aggregate/);
  const result = observeClaudeFile(ledger, path);
  assert.equal(result.appended, 4);
  assert.deepEqual(result.conflicts, []);
  assert.equal(project(readFacts(ledger)).messages.length, 1);
  assert.equal(readFacts(ledger).filter((fact) => isLegacyUnsupported(fact)).length, 2);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
});
test("取り込む発言は uuid と本文の構造を必要とし、任意の時刻欄は判定に使わない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "required.jsonl");
  const valid = { ...JSON.parse(createMessage("valid")), timestamp: "fictional-invalid-time" };
  writeFileSync(path, [JSON.stringify({ type: "user", message: { content: "Fictional body." } }),
    JSON.stringify({ type: "user", uuid: "missing-content", message: {} }),
    JSON.stringify(valid)].join("\n") + "\n");
  observeClaudeFile(ledger, path, { observedTs: TS });
  const unsupported = readFacts(ledger).filter((fact) => isLegacyUnsupported(fact));
  assert.equal(unsupported.length, 1);
  assert.equal((unsupported[0].payload as Partial<ClaudeUnsupportedPayload>).count, 2);
  assert.equal(project(readFacts(ledger)).messages.length, 1);
});
test("版のない旧記録を構造で確認し、本文の保存範囲と秘匿を台帳へ委ねる", (t) => {
  for (const storageScope of ["metadata", "message_body"] as const) {
    const { ledger, directory } = createFixture(t, { storageScope, redactionRules: { patterns: ["fictional-secret"] } });
    const path = join(directory, "session.jsonl");
    const row = JSON.parse(createMessage("secret", "fictional-secret"));
    delete row.version;
    writeFileSync(path, JSON.stringify(row) + "\n");
    observeClaudeFile(ledger, path);
    const message = project(readFacts(ledger)).messages[0];
    assert.equal(message.body_state, storageScope === "metadata" ? "omitted" : "stored");
    assert.ok(!JSON.stringify(readFacts(ledger)).includes("fictional-secret"));
  }
});
test("管理する会話の観測を残し、ホストの出所を優先する", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, `${createMessage("shared")}\n`);
  observeClaudeFile(ledger, path, { managed: true });
  const messageId = createNativeId("claude", "shared");
  ledger.append({ source: "host-claude", source_event_id: "host-message", kind: "message.created",
    subject: `message:${messageId}`, source_ts: TS, confidence: "confirmed",
    payload: { provider: "claude", native_id: "shared", version: 1, role: "user", body: "Host body.", body_state: "stored" } });
  const projection = project(readFacts(ledger));
  assert.equal(projection.conversations[0].origin, "managed");
  assert.equal(projection.messages[0].body, "Host body.");
  assert.equal(projection.discrepancies.length, 1);
  assert.ok(readFacts(ledger).some((fact) => fact.source === "transcript-claude" && fact.kind === "message.created"));
});
test("管理指定の後も origin を保持し、履歴の環境変数欄には依存しない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  const row = { ...JSON.parse(createMessage("first")), env: { AGENT_GRAPH_MANAGED: "1" }, AGENT_GRAPH_MANAGED: "1" };
  writeFileSync(path, JSON.stringify(row) + "\n");
  observeClaudeFile(ledger, path);
  assert.equal(project(readFacts(ledger)).conversations[0].origin, "observed");
  appendFileSync(path, `${createMessage("managed")}\n`);
  assert.equal(observeClaudeFile(ledger, path, { managed: true }).appended, 3);
  appendFileSync(path, `${createMessage("later")}\n`);
  observeClaudeFile(ledger, path, { managed: false });
  assert.equal(project(readFacts(ledger)).conversations[0].origin, "managed");
});
test("所属の追記前に停止しても、台帳の cursor から再読込して欠落を補う", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  writeFileSync(path, `${createMessage("first")}\n${createMessage("second")}\n`);
  const failingLedger: Ledger = {
    ...ledger,
    append(input) {
      if (input.kind === "message_membership.created" && input.payload.message_id === createNativeId("claude", "second")) {
        throw new Error("Simulated interrupted append");
      }
      return ledger.append(input);
    },
  };
  assert.throws(() => observeClaudeFile(failingLedger, path), /Simulated interrupted append/);
  assert.equal(readFacts(ledger).length, 4);
  assert.equal(observeClaudeFile(ledger, path).appended, 1);
  assert.equal(project(readFacts(ledger)).message_memberships.length, 2);
});

test("ai-title は最後の題名を記録し、同じ題名と再読で増殖しない", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "session.jsonl");
  const title = (aiTitle: string) => JSON.stringify({ type: "ai-title", aiTitle, sessionId: "session" }) + "\n";
  writeFileSync(path, createMessage("first") + "\n" + title("Old") + title("ブラウザ入力のターミナル反映"));
  const first = observeClaudeFile(ledger, path, { observedTs: TS });
  assert.equal(first.conflicts.length, 0);
  assert.equal(project(readFacts(ledger)).conversations[0].ai_title, "ブラウザ入力のターミナル反映");
  assert.equal(readFacts(ledger).filter(fact => fact.kind === "conversation.updated").length, 1);
  appendFileSync(path, title("ブラウザ入力のターミナル反映"));
  assert.equal(observeClaudeFile(ledger, path, { observedTs: TS }).appended, 0);
  appendFileSync(path, title("New"));
  observeClaudeFile(ledger, path, { observedTs: TS });
  assert.equal(project(readFacts(ledger)).conversations[0].ai_title, "New");
  const facts = readFacts(ledger);
  observeClaudeFile(ledger, path, { cursor: { ...first.cursor, identity: "replay" }, observedTs: TS });
  assert.deepEqual(readFacts(ledger), facts);
  assert.deepEqual(project([...facts].reverse()), project(facts));
});

test("jsonl の包みと自動挿入を投影で正規化し、最初の依頼だけを名前にする", t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "wrapped.jsonl");
  const bodies = ['<task-notification>終了</task-notification>',
    'Another Claude session sent a message:\n<agent-message from="a4dc">子の報告</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.',
    '\n\n<pasted_content id="d49b">\n最初の依頼。\n</pasted_content id="d49b">\n\n外の文\n<pasted_content id="b">\n次の本文\n</pasted_content id="b">'];
  writeFileSync(path, bodies.map((body, index) => createMessage(`wrapped-${index}`, body)).join("\n") + "\n");
  observeClaudeFile(ledger, path, { observedTs: TS });
  const facts = readFacts(ledger);
  const projection = project(facts);
  assert.deepEqual(projection.messages.map(message => [message.role, message.body]),
    [["notification", ""], ["agent_report", "子の報告"], ["user", "最初の依頼。\n\n外の文\n次の本文"]]);
  assert.equal(projection.conversations[0].first_request_excerpt, "最初の依頼。");
  assert.equal(projection.conversations[0].name, "最初の依頼。");
  const db = readLedgerDatabase(ledger);
  applyIncremental(db, 0);
  assert.deepEqual(db.prepare("SELECT role, content_normalized FROM messages ORDER BY native_id").all().map(row => [row.role, row.content_normalized]),
    [["notification", 1], ["agent_report", 1], ["user", 1]]);
  assert.deepEqual(project([...facts].reverse()), projection);
  observeClaudeFile(ledger, path, { observedTs: TS });
  assert.deepEqual(readFacts(ledger), facts);
});

test('real conversations remain ingested after changing cwd to the exact probe path', t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, 'real.jsonl');
  const message = (uuid: string, cwd: string) => JSON.stringify({ ...JSON.parse(createMessage(uuid)), cwd });
  writeFileSync(path, message('first', '/home/test/repo') + '\n');
  const first = observeClaudeFile(ledger, path);
  observeClaudeContext(ledger, path, { lines: first.lines, fromStart: true });
  appendFileSync(path, message('next', USAGE_PROBE_PATH) + '\n');
  const next = observeClaudeFile(ledger, path, { cursor: first.cursor });
  observeClaudeContext(ledger, path, { lines: next.lines });
  appendFileSync(path, message('last', '/home/test/repo') + '\n');
  const last = observeClaudeFile(ledger, path, { cursor: next.cursor });
  const facts = readFacts(ledger);
  assert.equal(last.appended > 0, true);
  assert.deepEqual(project(facts).messages.map(row => row.native_id).sort(), ['first', 'last', 'next']);
  assert.equal(project(facts).conversations[0].cwd, '/home/test/repo');
  assert.equal(facts.some(fact => fact.kind === 'run.created'), true);
  const fresh = openLedger(':memory:');
  t.after(() => fresh.close());
  observeClaudeFile(fresh, path);
  observeClaudeContext(fresh, path);
  assert.deepEqual(project(readFacts(fresh)), project(facts));
});

test('transcripts starting at the probe path are ingested without permanent cursor exclusion', t => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, 'real-at-probe.jsonl');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(createMessage('first')), cwd: USAGE_PROBE_PATH }) + '\n');
  const first = observeClaudeFile(ledger, path);
  const legacyCursor = { ...first.cursor, usageProbe: true };
  appendFileSync(path, createMessage('next') + '\n');
  observeClaudeFile(ledger, path, { cursor: legacyCursor });
  assert.deepEqual(project(readFacts(ledger)).messages.map(row => row.native_id).sort(), ['first', 'next']);
});
