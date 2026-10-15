import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyIncremental, openLedger, PROJECTION_TABLES, rebuild } from "../../src/ledger/index.ts";
import type { FactInput } from "../../src/ledger/index.ts";

const FACT_COUNT = 50_000;
const BATCH_SIZE = 100;
const BATCH_UPDATE_COUNT = 20;
const BATCH_LIMIT_MS = 300;
const SEQUENTIAL_LIMIT_MS = 60_000;
const WARMUP_FACT_COUNT = 10;
const TS = "2026-01-01T00:00:00Z";

function createInput(index: number, conversationCount: number): FactInput {
  const message = Math.floor(index / 2);
  return { source: "host-codex", source_event_id: `event-${index}`,
    source_ts: new Date(Date.parse(TS) + message * 1000).toISOString(), observed_ts: TS,
    confidence: "confirmed",
    kind: index % 2 === 0 ? "message.created" : "message_membership.created",
    subject: index % 2 === 0 ? `message:${message}` : `message_membership:${message}`,
    payload: index % 2 === 0
      ? { provider: "codex", native_id: `message-${message}`, version: 1, role: "user",
        body: `Performance fixture ${message}`, body_state: "stored" }
      : { message_id: String(message), conversation_id: String(message % conversationCount), active: true } } as FactInput;
}

function readTables(database: DatabaseSync) {
  return Object.fromEntries(PROJECTION_TABLES.map((table) => [table,
    database.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row })),
  ]));
}

for (const conversationCount of [1, 5]) test(`会話 ${conversationCount} 個への 5 万件の逐次反映は 60 秒以内、100 件の反映は 300 ms 以内`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-perf-"));
  const path = join(directory, "ledger.sqlite");
  const writer = openLedger(path);
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); writer.close(); rmSync(directory, { recursive: true }); });
  for (let index = 0; index < conversationCount; index += 1) {
    writer.append({ source: "host-codex", source_event_id: `conversation-${index}`, source_ts: TS,
      confidence: "confirmed", kind: "conversation.created", subject: `conversation:${index}`,
      payload: { provider: "codex", native_id: `conversation-${index}`, type: "interactive", origin: "managed", history_format: "jsonl" } });
  }
  let cursor = applyIncremental(database, 0).last_seq;
  // 小規模なウォームアップで初回の型除去・JIT の時間を測定から除く。
  for (let index = 0; index < WARMUP_FACT_COUNT; index += 1) {
    writer.append(createInput(index, conversationCount));
    cursor = applyIncremental(database, cursor).last_seq;
  }

  const sequentialStart = performance.now();
  let incrementalMs = 0;
  for (let index = WARMUP_FACT_COUNT; index < FACT_COUNT + WARMUP_FACT_COUNT; index += 1) {
    writer.append(createInput(index, conversationCount));
    const incrementalStart = performance.now();
    cursor = applyIncremental(database, cursor).last_seq;
    incrementalMs += performance.now() - incrementalStart;
  }
  const sequentialMs = performance.now() - sequentialStart;
  t.diagnostic(`50,000 append + applyIncremental: ${sequentialMs.toFixed(1)} ms`);
  t.diagnostic(`50,000 applyIncremental total: ${incrementalMs.toFixed(1)} ms`);
  assert.ok(incrementalMs < SEQUENTIAL_LIMIT_MS, `${incrementalMs.toFixed(1)} ms > ${SEQUENTIAL_LIMIT_MS} ms`);

  // 新しい発言と既存の発言の更新を混ぜ、既存台帳も読み出す。
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const input = createInput(FACT_COUNT + WARMUP_FACT_COUNT + index, conversationCount);
    writer.append(index < BATCH_SIZE - BATCH_UPDATE_COUNT ? input : {
      source: "host-codex", source_event_id: `update-${index}`, source_ts: "2026-01-02T00:00:00Z",
      confidence: "confirmed", kind: "message.updated", subject: `message:${index - (BATCH_SIZE - BATCH_UPDATE_COUNT)}`, payload: { body: "Updated fixture" },
    });
  }
  const batchStart = performance.now();
  const state = applyIncremental(database, cursor);
  const batchMs = performance.now() - batchStart;
  t.diagnostic(`100 facts applyIncremental: ${batchMs.toFixed(1)} ms`);
  assert.ok(batchMs < BATCH_LIMIT_MS, `${batchMs.toFixed(1)} ms > ${BATCH_LIMIT_MS} ms`);
  assert.equal(state.last_seq, conversationCount + FACT_COUNT + WARMUP_FACT_COUNT + BATCH_SIZE);
  const incremental = readTables(database);
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
});

const EVIDENCE_FACT_COUNT = 20_000;
const EVIDENCE_APPEND_LIMIT_MS = 60;
test(`原記録の証拠 ${EVIDENCE_FACT_COUNT.toLocaleString("en")} 件を持つ実行への 1 件の証拠と対応の繰り返しは、全事実を読み直さず ${EVIDENCE_APPEND_LIMIT_MS} ms 以内に反映する`, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ledger-evidence-perf-"));
  const path = join(directory, "ledger.sqlite");
  const writer = openLedger(path);
  const database = new DatabaseSync(path);
  t.after(() => { database.close(); writer.close(); rmSync(directory, { recursive: true }); });
  const at = (index: number) => new Date(Date.parse(TS) + index * 1000).toISOString();
  const evidence = (index: number): FactInput => ({ source: "transcript-claude", source_event_id: `evidence-${index}`, source_ts: at(index),
    confidence: "confirmed", kind: "run.updated", subject: "run:r",
    payload: { conversation_id: "c", generation: 1, last_evidence: { native_source: "claude", native_record: { type: "assistant", uuid: `u-${index}`, parentUuid: `u-${index - 1}` } },
      last_evidence_ts: at(index) } } as FactInput);
  writer.append({ source: "transcript-claude", source_event_id: "conversation", source_ts: TS, confidence: "confirmed", kind: "conversation.created",
    subject: "conversation:c", payload: { provider: "claude", native_id: "c", type: "interactive", origin: "observed", history_format: "jsonl" } });
  writer.append({ source: "transcript-claude", source_event_id: "run", source_ts: TS, confidence: "confirmed", kind: "run.created",
    subject: "run:r", payload: { conversation_id: "c", generation: 1, state: "running" } });
  for (let index = 1; index <= EVIDENCE_FACT_COUNT; index += 1) writer.append(evidence(index));
  let cursor = rebuild(database).last_seq;
  const timings: number[] = [];
  for (let round = 1; round <= 5; round += 1) {
    writer.append(round % 2 ? evidence(EVIDENCE_FACT_COUNT + round) : { source: "ui", source_event_id: `restated-${round}`,
      source_ts: at(EVIDENCE_FACT_COUNT + round), confidence: "confirmed", kind: "run.updated", subject: "run:r", payload: { conversation_id: "c", generation: 1 } } as FactInput);
    const start = performance.now();
    cursor = applyIncremental(database, cursor).last_seq;
    timings.push(performance.now() - start);
  }
  // 初回は文の準備を含むため、残りの最大で判定する。
  const worst = Math.max(...timings.slice(1));
  t.diagnostic(`evidence append applyIncremental: ${timings.map((value) => value.toFixed(1)).join(", ")} ms`);
  assert.ok(worst < EVIDENCE_APPEND_LIMIT_MS, `${worst.toFixed(1)} ms > ${EVIDENCE_APPEND_LIMIT_MS} ms`);
  const incremental = readTables(database);
  const record = database.prepare("SELECT data FROM entity_records WHERE entity = 'run' AND id = 'r'").get()!.data;
  rebuild(database);
  assert.deepEqual(readTables(database), incremental);
  assert.equal(database.prepare("SELECT data FROM entity_records WHERE entity = 'run' AND id = 'r'").get()!.data, record);
});
