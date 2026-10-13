import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyIncremental, openLedger, readLedgerDatabase, rebuild } from "../../core/src/ledger/index.ts";
import { observeClaudeFile } from "../src/observe/claude/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";

test("旧い subject の会話へ native ID の enqueue を結び、snapshot と patch に配る", t => {
  const directory = mkdtempSync(join(tmpdir(), "input-queue-legacy-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  const timestamp = "2026-10-13T00:00:00Z";
  const id = '["claude","session"]';
  ledger.append({ source: "hook", source_event_id: "legacy", subject: "conversation:claude:session",
    kind: "conversation.created", confidence: "confirmed", source_ts: timestamp,
    payload: { provider: "claude", native_id: "session", origin: "observed", type: "interactive", history_format: "jsonl" } });
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  t.after(() => { feed.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  ledger.append({ source: "transcript-claude", source_event_id: "input-queue:session:0001",
    subject: `conversation:${id}`, kind: "conversation.input_queue_changed", confidence: "confirmed", source_ts: timestamp,
    payload: { input_queue_event: { operation: "enqueue", body: "First line\nSecond line" } } });
  const patch = feed.refresh();
  assert.ok(patch && patch !== "resync");
  const rows = patch.changes.conversations.upsert;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.deepEqual(rows[0].pending_inputs, [{ id: "input-queue:session:0001", body: "First line\nSecond line", source_ts: "2026-10-13T00:00:00.000Z", state: "queued" }]);
  const before = feed.snapshot().projection.conversations;
  rebuild(db); feed.refresh();
  assert.deepEqual(feed.snapshot().projection.conversations, before);
});

test("待ち行列を snapshot と patch に配り、再構築でも一致する", t => {
  const directory = mkdtempSync(join(tmpdir(), "input-queue-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  const transcript = join(directory, "session.jsonl");
  const timestamp = "2026-10-13T00:00:00Z";
  const enqueue = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "Next step", timestamp });
  writeFileSync(transcript, enqueue + "\n");
  observeClaudeFile(ledger, transcript);
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  t.after(() => { feed.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const queued = feed.snapshot().projection.conversations[0].pending_inputs;
  assert.equal((queued as { state: string }[])[0].state, "queued");
  appendFileSync(transcript, JSON.stringify({ type: "queue-operation", operation: "dequeue" }) + "\n");
  observeClaudeFile(ledger, transcript);
  const patch = feed.refresh();
  assert.ok(patch && patch !== "resync");
  assert.equal(patch.identities, undefined);
  assert.deepEqual(patch.changes.conversations.upsert[0].pending_inputs, []);
  appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "read", timestamp,
    message: { role: "user", content: "Next step" } }) + "\n");
  observeClaudeFile(ledger, transcript);
  feed.refresh();
  assert.deepEqual(feed.snapshot().projection.conversations[0].pending_inputs, []);
  rebuild(db);
  feed.refresh();
  assert.deepEqual(feed.snapshot().projection.conversations[0].pending_inputs, []);
});

test("run の終了・再開だけの変更でも待ち行列を patch と再構築に反映する", t => {
  const directory = mkdtempSync(join(tmpdir(), "input-queue-runs-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path);
  const db = readLedgerDatabase(ledger);
  const timestamp = (second: number) => `2026-10-13T00:00:0${second}Z`;
  ledger.append({ source: "host-claude", source_event_id: "conversation", subject: "conversation:c",
    kind: "conversation.created", confidence: "confirmed", source_ts: timestamp(0),
    payload: { provider: "claude", native_id: "session", origin: "managed", type: "interactive", history_format: "jsonl" } });
  const id = '["claude","session"]';
  const start = (generation: number, second: number) => ledger.append({ source: "host-claude",
    source_event_id: `start:${generation}`, subject: `run:r${generation}`, kind: "run.created",
    confidence: "confirmed", source_ts: timestamp(second), payload: { conversation_id: "c", generation,
      state: "running", started_ts: timestamp(second) } });
  const enqueue = (second: number) => ledger.append({ source: "transcript-claude",
    source_event_id: `input-queue:c:${second}`, subject: "conversation:c", kind: "conversation.input_queue_changed",
    confidence: "confirmed", source_ts: timestamp(second),
    payload: { input_queue_event: { operation: "enqueue", body: "Unread" } } });
  start(1, 0);
  enqueue(1);
  const feed = new ProjectionFeed(path, () => applyIncremental(db, 0));
  t.after(() => { feed.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((feed.conversation(id).projection.conversations[0].pending_inputs as unknown[]).length, 1);
  ledger.append({ source: "host-claude", source_event_id: "end", subject: "run:r1", kind: "run.state_changed",
    confidence: "confirmed", source_ts: timestamp(2),
    payload: { state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } } });
  const ended = feed.refresh();
  assert.ok(ended && ended !== "resync");
  assert.deepEqual(ended.changes.conversations.upsert.find(row => row.id === id)?.pending_inputs, []);
  enqueue(3);
  feed.refresh();
  assert.equal((feed.conversation(id).projection.conversations[0].pending_inputs as unknown[]).length, 1);
  start(2, 4);
  const restarted = feed.refresh();
  assert.ok(restarted && restarted !== "resync");
  assert.deepEqual(restarted.changes.conversations.upsert.find(row => row.id === id)?.pending_inputs, []);
  enqueue(5);
  feed.refresh();
  const before = feed.conversation(id).projection.conversations;
  rebuild(db);
  feed.refresh();
  assert.deepEqual(feed.conversation(id).projection.conversations, before);
});
