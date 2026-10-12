import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openBatchLedger } from "../src/service/batch-ledger.ts";
import type { FactInput } from "../../core/src/ledger/index.ts";

const BODY_BYTES = 2 * 1024 * 1024;
const FACT_COUNT = 10;
test("大きな本文の準備台帳を途中で区切っても、再読の識別子と本文を保持する", t => {
  const directory = mkdtempSync(join(tmpdir(), "api-batch-bytes-"));
  const { ledger, batch } = openBatchLedger(join(directory, "ledger.db"));
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const body = "x".repeat(BODY_BYTES);
  const input = (i: number): FactInput => ({ source: "host-codex", source_event_id: `large-${i}`,
    source_ts: "2026-10-13T00:00:00Z", confidence: "confirmed", kind: "message.created", subject: `message:m${i}`,
    payload: { provider: "codex", native_id: `m${i}`, role: "assistant", version: 1, body, body_state: "stored" } });
  batch(() => {
    for (let i = 0; i < FACT_COUNT; i++) assert.equal(ledger.append(input(i)).status, "appended");
    // 前半の事実は保存先へ移った後も、同じ入力として読み戻せる。
    assert.equal(ledger.readSince(0, FACT_COUNT).length, FACT_COUNT);
    for (let i = 0; i < FACT_COUNT; i++) assert.equal(ledger.append(input(i)).status, "duplicate");
    assert.equal(ledger.append({ ...input(0), payload: { ...input(0).payload, body: "changed" } } as FactInput).status, "conflict");
  });
  const facts = ledger.readSince(0, FACT_COUNT + 1);
  assert.equal(facts.length, FACT_COUNT);
  for (const [i, fact] of facts.entries()) {
    assert.ok(fact.kind === "message.created");
    assert.equal(fact.source_event_id, `large-${i}`);
    assert.equal(fact.payload?.body, body);
  }
});
