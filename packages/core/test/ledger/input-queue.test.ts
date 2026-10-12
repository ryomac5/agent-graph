import assert from "node:assert/strict";
import test from "node:test";
import { openLedger } from "../../src/ledger/index.ts";
import { projectInputQueues } from "../../src/ledger/projections/input-queue.ts";

test("dequeue は先頭だけ、remove は本文が一致する一件、popAll は全件を消す", t => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  let offset = 0;
  const append = (operation: string, body?: string, delivery_id?: string) => ledger.append({
    source: "transcript-claude", source_event_id: `input-queue:c:${String(++offset).padStart(16, "0")}`,
    subject: "conversation:c", kind: "conversation.input_queue_changed", confidence: "confirmed",
    source_ts: "2026-10-13T00:00:00Z", payload: { input_queue_event: { operation, body, delivery_id } },
  });
  const read = () => projectInputQueues(ledger.readSince(0, Number.MAX_SAFE_INTEGER)).get("c")!;
  append("enqueue", "First");
  append("enqueue", "Same");
  append("enqueue", "Same");
  append("future");
  append("dequeue");
  assert.deepEqual(read().map(input => input.body), ["Same", "Same"]);
  append("remove", "<pasted_content>Same</pasted_content>", "remove-only-id");
  assert.deepEqual(read().map(input => input.body), ["Same"]);
  append("user", "Same");
  assert.equal(read().length, 1);
  append("popAll", "Same");
  assert.deepEqual(read(), []);
  append("enqueue", "<agent-message agent_id=\"other\">Report</agent-message>");
  append("enqueue", "<task-notification><summary>Done</summary></task-notification>");
  assert.deepEqual(read(), []);
  append("enqueue", "Later");
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(projectInputQueues([...facts].reverse()), projectInputQueues([...facts, ...facts]));
  assert.equal(read()[0].state, "queued");
});

test("run の終了と新しい開始で未読の入力を持ち越さない", t => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const enqueue = (second: number) => ledger.append({ source: "transcript-claude",
    source_event_id: `input-queue:c:${second}`, subject: "conversation:c", kind: "conversation.input_queue_changed",
    confidence: "confirmed", source_ts: `2026-10-13T00:00:0${second}Z`,
    payload: { input_queue_event: { operation: "enqueue", body: "Unread" } } });
  const start = (generation: number, second: number) => ledger.append({ source: "host-claude",
    source_event_id: `start:${generation}`, subject: `run:r${generation}`, kind: "run.created", confidence: "confirmed",
    source_ts: `2026-10-13T00:00:0${second}Z`, payload: { conversation_id: "c", generation,
      state: "running", started_ts: `2026-10-13T00:00:0${second}Z` } });
  const read = () => projectInputQueues(ledger.readSince(0, Number.MAX_SAFE_INTEGER)).get("c");
  start(1, 0);
  enqueue(1);
  assert.equal(read()?.length, 1);
  ledger.append({ source: "host-claude", source_event_id: "end", subject: "run:r1", kind: "run.state_changed",
    confidence: "confirmed", source_ts: "2026-10-13T00:00:02Z",
    payload: { state: "ended", end_evidence: { kind: "host_exit", exit_code: 0 } } });
  assert.deepEqual(read(), []);
  enqueue(3);
  start(2, 4);
  assert.deepEqual(read(), []);
  enqueue(5);
  assert.equal(read()?.length, 1);
  const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(projectInputQueues([...facts].reverse()), projectInputQueues(facts));
});

test("待ち行列の本文にも保存前の秘匿と保存範囲を適用する", t => {
  for (const storageScope of ["metadata", "message_body"] as const) {
    const ledger = openLedger(":memory:", { storageScope });
    t.after(() => ledger.close());
    ledger.append({ source: "transcript-claude", source_event_id: "input-queue:1", subject: "conversation:c",
      kind: "conversation.input_queue_changed", confidence: "confirmed", source_ts: "2026-10-13T00:00:00Z",
      payload: { input_queue_event: { operation: "enqueue", body: "API_KEY=secret-value" } } });
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.ok(!JSON.stringify(facts).includes("secret-value"));
    if (storageScope === "metadata") assert.deepEqual(projectInputQueues(facts).get("c"), []);
  }
});
