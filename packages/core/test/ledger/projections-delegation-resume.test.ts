import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyIncremental, openLedger, rebuild } from "../../src/ledger/index.ts";
import type { FactInput } from "../../src/ledger/facts.ts";
import { projectDelegations, projectEntityRecords } from "../../src/ledger/projections/delegations.ts";
import { projectConversations } from "../../src/ledger/projections/conversations.ts";
import { projectRuns } from "../../src/ledger/projections/runs.ts";

test("resume preserves the delegated conversation and its parent relation while creating a new run generation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "projections-delegation-resume-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path, { storageScope: "full_diff" });
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); ledger.close(); rmSync(directory, { recursive: true }); });
  const inputs = [
    ["hook", "conversation.created", "conversation:origin", { provider: "claude", native_id: "terminal", origin: "observed", type: "interactive", history_format: "jsonl", name: "Terminal origin" }],
    ["intake", "delegation.created", "delegation:implementation", { request_id: "implementation", title: "Review fixture task", role: "implement", task: "Implement", accept: [], origin: { provider: "claude", native_id: "terminal" }, attempt: 1, state: "received" }],
    ["host-codex", "conversation.created", "conversation:implementation", { provider: "codex", native_id: "implementer", origin: "managed", type: "interactive", history_format: "jsonl" }],
    ["host-codex", "run.created", "run:first", { conversation_id: "implementation", generation: 1, state: "running" }],
    ["intake", "delegation.attempt_created", "delegation:implementation", { attempt: 1, run_id: "first", assignment: { provider: "codex", model: "gpt" } }],
    ["intake", "relation.created", "relation:implementation", { type: "delegated", from_id: "origin", to_id: "implementation", confidence: "confirmed", active: true, evidence: { request_id: "implementation", attempt: 1 } }],
    ["host-codex", "run.state_changed", "run:first", { generation: 1, state: "ended", end_evidence: { kind: "thread_closed" } }],
    ["intake", "delegation.state_changed", "delegation:implementation", { attempt: 1, state: "done" }],
    ["host-codex", "run.created", "run:resumed", { conversation_id: "implementation", generation: 2, state: "running" }],
    ["host-codex", "conversation.updated", "conversation:implementation", { origin: "managed", native_id: "implementer" }],
    ["host-codex", "run.state_changed", "run:resumed", { generation: 2, state: "ended", end_evidence: { kind: "thread_closed" } }],
    ["host-claude", "conversation.created", "conversation:review", { provider: "claude", native_id: "reviewer", origin: "managed", type: "subagent", history_format: "jsonl", name: "Review of Review fixture task" }],
    ["host-claude", "run.created", "run:review", { conversation_id: "review", generation: 1, state: "running" }],
    ["intake", "relation.created", "relation:review", { type: "review_of", from_id: "review", to_id: "implementation", confidence: "confirmed", active: true, evidence: { run_id: "resumed", artifact_id: "version-2" } }],
  ] as const;
  for (const [index, [source, kind, subject, payload]] of inputs.entries()) {
    const input = { source, kind, subject, payload, confidence: "confirmed", source_event_id: String(index),
      source_ts: new Date(Date.UTC(2026, 9, 7, 0, 0, index)).toISOString() } as unknown as FactInput;
    ledger.append(input);
    ledger.append(input);
    applyIncremental(database, 0);
  }
  const facts = ledger.readSince(0, 100);
  assert.equal(facts.length, inputs.length);
  const readProjection = (ordered: typeof facts) => ({
    ...projectConversations(ordered), delegations: projectDelegations(ordered), runs: projectRuns(ordered),
  });
  const projected = readProjection(facts);
  assert.deepEqual(readProjection([...facts].reverse()), projected);
  assert.equal(projected.conversations.length, 3);
  assert.equal(projected.delegations.length, 1);
  const delegation = projected.delegations[0];
  // 再開は受付の再試行ではない。元の試行と同じ会話への関係を残す。
  assert.equal(delegation.state, "done");
  assert.deepEqual(delegation.attempts.map(attempt => attempt.run_id), ["first"]);
  assert.deepEqual(delegation.parent, { confidence: "confirmed", conversation_id: "origin" });
  assert.deepEqual(projected.runs.filter(run => run.conversation_id === "implementation")
    .map(run => [run.id, run.generation, run.state]), [["implementation:1", 1, "ended"], ["implementation:2", 2, "ended"]]);
  const originalRuns = projectEntityRecords<{ conversation_id: string }>(facts, "run");
  assert.equal(originalRuns.find(run => run.id === "first")!.conversation_id, "implementation");
  assert.equal(originalRuns.find(run => run.id === "resumed")!.conversation_id, "implementation");
  const relation = projected.relations.find(row => row.type === "delegated")!;
  assert.equal(relation.from_id, '["claude","terminal"]');
  assert.equal(relation.to_id, '["codex","implementer"]');
  const review = projected.relations.find(row => String(row.type) === "review_of")!;
  assert.equal(review.from_id, '["claude","reviewer"]');
  assert.equal(review.to_id, relation.to_id);
  const readStored = () => ({
    conversations: database.prepare("SELECT * FROM conversations ORDER BY id").all(),
    runs: database.prepare("SELECT * FROM runs ORDER BY id").all(),
    delegations: database.prepare("SELECT * FROM delegations ORDER BY id").all(),
    relations: database.prepare("SELECT * FROM relations ORDER BY id").all(),
  });
  const incremental = readStored();
  assert.equal(incremental.delegations.length, 1);
  assert.equal(incremental.conversations.length, 3);
  assert.equal(incremental.runs.length, 3);
  assert.equal(incremental.relations.length, 2);
  rebuild(database);
  assert.deepEqual(readStored(), incremental);
});
