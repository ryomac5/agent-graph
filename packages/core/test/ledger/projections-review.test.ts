import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyIncremental, openLedger, rebuild } from "../../src/ledger/index.ts";
import type { FactInput } from "../../src/ledger/facts.ts";
import { projectConversations } from "../../src/ledger/projections/conversations.ts";

const TS = "2026-10-07T00:00:00.000Z";
const inputs = [
  ["task.created", "task:implementation", { name: "Fix code", purpose: "Fix code", project: "/repo", state: "done" }],
  ["conversation.created", "conversation:implementation", { provider: "codex", native_id: "implementer", origin: "managed", type: "interactive", history_format: "jsonl", task_id: "implementation", name: "Implementation conversation" }],
  ["conversation.created", "conversation:review", { provider: "claude", native_id: "review", origin: "managed", type: "subagent", history_format: "jsonl", task_id: "implementation", name: "Review of Fix code" }],
  ["relation.created", "relation:review", { type: "review_of", from_id: "review", to_id: "implementation", evidence: { artifact_id: "artifact", patch_hash: "hash" }, confidence: "confirmed", active: true }],
  ["conversation.updated", "conversation:review", { native_id: "review-session" }],
  ["message.created", "message:review", { provider: "claude", native_id: "reply", version: 1, role: "assistant", phase: "final_answer", body: '{"verdict":"approve","comment":"OK"}', body_state: "stored" }],
  ["message_membership.created", "message_membership:review", { conversation_id: "review", message_id: "review", active: true }],
] as const;

test("review conversation preserves its readable name, original task and project, and review relation after native identity updates", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "projections-review-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path, { storageScope: "full_diff" });
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); ledger.close(); rmSync(directory, { recursive: true }); });
  for (const [index, [kind, subject, payload]] of inputs.entries()) {
    const input = { source: "ui", source_event_id: String(index), source_ts: TS, kind, subject, payload, confidence: "confirmed" } as unknown as FactInput;
    ledger.append(input);
    ledger.append(input);
    applyIncremental(database, 0);
  }
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, inputs.length);
  const projected = projectConversations(facts);
  assert.deepEqual(projectConversations([...facts].reverse()), projected);
  const child = projected.conversations.find(row => row.id === '["claude","review-session"]')!;
  assert.deepEqual(projectConversations(facts, new Map([[child.id, '{"verdict":"approve"}']])), projected);
  assert.equal(projected.conversations.find(row => row.provider === "codex")!.name, "Fix code");
  assert.equal(child.name, "Review of Fix code");
  assert.equal(child.name_is_provisional, false);
  assert.equal(child.task_id, "implementation");
  assert.equal(projected.tasks.find(task => task.id === child.task_id)!.project, "/repo");
  assert.equal(projected.relations[0].from_id, child.id);
  assert.equal(projected.relations[0].to_id, '["codex","implementer"]');
  assert.equal(String(projected.relations[0].type), "review_of");
  const read = () => ({
    conversations: database.prepare("SELECT * FROM conversations ORDER BY id").all(),
    tasks: database.prepare("SELECT * FROM tasks ORDER BY id").all(),
    relations: database.prepare("SELECT * FROM relations ORDER BY id").all(),
  });
  const incremental = read();
  const storedChild = incremental.conversations.find(row => row.id === child.id)!;
  assert.equal(storedChild.name, child.name);
  assert.equal(incremental.tasks.find(row => row.id === storedChild.task_id)!.project, "/repo");
  assert.equal(incremental.relations.find(row => row.from_id === child.id)!.to_id, '["codex","implementer"]');
  rebuild(database);
  assert.deepEqual(read(), incremental);
});

test("review responses never become provisional subagent names, including cached incremental names", () => {
  const facts = inputs.filter(([kind, subject]) => kind !== "task.created" && subject !== "relation:review")
    .map(([kind, subject, payload], index) => ({
      kind, subject, payload: kind === "conversation.created" ? { ...payload, task_id: undefined, name: undefined } : payload,
      source: "ui", source_event_id: String(index), source_ts: TS, observed_ts: TS,
      fact_id: String(index), seq: index + 1, confidence: "confirmed", schema_version: 1, payload_hash: "hash", cursor: null, supersedes: null,
    })) as unknown as Parameters<typeof projectConversations>[0];
  for (const names of [undefined, new Map([['["claude","review-session"]', '{"verdict":"approve"}']])]) {
    const review = projectConversations(facts, names).conversations.find(row => row.type === "subagent")!;
    assert.equal(review.name, null);
    assert.equal(review.name_is_provisional, false);
  }
});

test("a reviewer uses its explicit name even when its task has not been projected yet", () => {
  const facts = inputs.filter(([kind]) => kind !== "task.created")
    .map(([kind, subject, payload], index) => ({
      kind, subject, payload,
      source: "ui", source_event_id: String(index), source_ts: TS, observed_ts: TS,
      fact_id: String(index), seq: index + 1, confidence: "confirmed", schema_version: 1, payload_hash: "hash", cursor: null, supersedes: null,
    })) as unknown as Parameters<typeof projectConversations>[0];
  const review = projectConversations(facts).conversations.find(row => row.provider === "claude")!;
  assert.equal(review.name, "Review of Fix code");
  assert.equal(review.name_is_provisional, false);
});

test("indexed conversation names bypass message projection during incremental updates", () => {
  const facts = inputs.filter(([kind]) => kind !== "task.created").map(([kind, subject, payload], index) => ({
    kind, subject, payload: kind === "message.created" ? {
      ...payload,
      get body() { throw new Error("Message history must not be read when indexed names are supplied"); },
    } : subject === "conversation:implementation" ? { ...payload, name: undefined } : payload,
    source: "ui", source_event_id: String(index), source_ts: TS, observed_ts: TS,
    fact_id: String(index), seq: index + 1, confidence: "confirmed", schema_version: 1, payload_hash: "hash", cursor: null, supersedes: null,
  })) as unknown as Parameters<typeof projectConversations>[0];
  const projected = projectConversations(facts, new Map([['["codex","implementer"]', "Indexed request"]]));
  assert.equal(projected.conversations.find(row => row.provider === "claude")!.name, "Review of Fix code");
  assert.equal(projected.conversations.find(row => row.provider === "codex")!.name, "Indexed request");
});

test("explicit task and reviewer names bypass message history without an incremental name index", () => {
  const facts = inputs.map(([kind, subject, payload], index) => ({
    kind, subject, payload: kind === "message.created" ? {
      ...payload,
      get body() { throw new Error("Named conversations must not reproject message history"); },
    } : payload,
    source: "ui", source_event_id: String(index), source_ts: TS, observed_ts: TS,
    fact_id: String(index), seq: index + 1, confidence: "confirmed", schema_version: 1, payload_hash: "hash", cursor: null, supersedes: null,
  })) as unknown as Parameters<typeof projectConversations>[0];
  const projected = projectConversations(facts);
  assert.equal(projected.conversations.find(row => row.provider === "claude")!.name, "Review of Fix code");
  assert.equal(projected.conversations.find(row => row.provider === "codex")!.name, "Fix code");
});
