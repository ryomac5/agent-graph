import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createNativeId, openLedger, project } from "../../../core/src/ledger/index.ts";
import type { FactInput, Ledger, LedgerOptions } from "../../../core/src/ledger/index.ts";
import { observeClaudeFile, observeClaudeProjects } from "../../src/observe/claude/index.ts";

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
test("未知の版・構造・JSON を未対応とし、会話を隠さず、再送を数えない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "future.jsonl");
  writeFileSync(path, [createMessage("future", "Future body.", "99.0.0"),
    JSON.stringify({ type: "future-record" }), JSON.stringify({ type: "user", uuid: "missing-body" }), "{bad-json}"].join("\n") + "\n");
  assert.equal(observeClaudeFile(ledger, path, { observedTs: TS }).appended, 5);
  const projection = project(readFacts(ledger));
  assert.equal(projection.conversations.length, 1);
  assert.equal(projection.messages.length, 0);
  assert.equal(projection.unsupported_observations.reduce((sum, row) => sum + row.count, 0), 4);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
});
test("実測された7版の発言を取り込み、それ以外の版を未対応とする", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "versions.jsonl");
  const versions = ["2.1.285", "2.1.286", "2.1.287", "2.1.288", "2.1.289", "2.1.290", "2.1.291"];
  writeFileSync(path, [...versions, "2.1.284", "2.1.292", "2.1.9"].map((version) =>
    createMessage(`version-${version}`, "Versioned message.", version)).join("\n") + "\n");
  const result = observeClaudeFile(ledger, path);
  assert.deepEqual(result.conflicts, []);
  const projection = project(readFacts(ledger));
  assert.deepEqual(projection.messages.map((row) => row.native_id).sort(), versions.map((version) => `version-${version}`));
  assert.deepEqual(projection.unsupported_observations.map((row) => row.format_version).sort(), ["2.1.284", "2.1.292", "2.1.9"]);
});
test("実在する補助記録を無視し、後続の発言を取り込む", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "metadata.jsonl");
  const types = ["attachment", "ai-title", "permission-mode", "mode", "atis-latch", "cost-state", "file-history-delta", "bridge-session"];
  writeFileSync(path, [...types.map((type) => JSON.stringify({ type, version: "2.1.291" })),
    createMessage("after-metadata")].join("\n") + "\n");
  assert.equal(observeClaudeFile(ledger, path).appended, 3);
  const projection = project(readFacts(ledger));
  assert.equal(projection.unsupported_observations.length, 0);
  assert.deepEqual(projection.messages.map((row) => row.native_id), ["after-metadata"]);
  assert.equal(observeClaudeFile(ledger, path).appended, 0);
});
test("未対応はファイル・版・理由ごとに一件で、追記と置き換えでも増殖しない", (t) => {
  const { ledger, directory } = createFixture(t);
  const path = join(directory, "unsupported.jsonl");
  const row = createMessage("future-first", "Future body.", "99.0.0");
  writeFileSync(path, `${row}\n${createMessage("future-second", "Other body.", "99.0.0")}\n`);
  const first = observeClaudeFile(ledger, path);
  assert.equal(first.appended, 2);
  assert.deepEqual(first.conflicts, []);
  appendFileSync(path, `${createMessage("future-third", "Third body.", "99.0.0")}\n`);
  const added = observeClaudeFile(ledger, path);
  assert.equal(added.appended, 0);
  assert.deepEqual(added.conflicts, []);
  const replacement = `${path}.new`;
  writeFileSync(replacement, `${row}\n`);
  renameSync(replacement, path);
  const replaced = observeClaudeFile(ledger, path);
  assert.equal(replaced.reset, true);
  assert.equal(replaced.appended, 0);
  assert.deepEqual(replaced.conflicts, []);
  appendFileSync(path, JSON.stringify({ type: "future-record", version: "2.1.291" }) + "\n"
    + createMessage("other-version", "Body.", "99.0.1") + "\n");
  assert.equal(observeClaudeFile(ledger, path).appended, 2);
  const otherPath = join(directory, "another.jsonl");
  writeFileSync(otherPath, `${row}\n`);
  assert.equal(observeClaudeFile(ledger, otherPath).appended, 2);
  assert.equal(readFacts(ledger).filter((fact) => fact.kind === "observation.unsupported").length, 4);
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
