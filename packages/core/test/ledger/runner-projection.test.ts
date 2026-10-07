import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openLedger, readLedgerDatabase, applyIncremental, rebuild, projectEntityRecords } from "../../src/ledger/index.ts";
import type { FactInput } from "../../src/ledger/index.ts";

test("runner records preserve corrections and incremental updates; old projection versions rebuild atomically", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runner-projection-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path, { storageScope: "full_diff" });
  const db = readLedgerDatabase(ledger);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const append = (event: string, payload: object, supersedes?: string) => ledger.append({ source: "host-codex", source_event_id: event,
    source_ts: "2026-01-01T00:00:00Z", kind: supersedes ? "run.corrected" : "run.created", subject: "run:target",
    confidence: "confirmed", payload, ...(supersedes ? { supersedes } : {}) } as FactInput);
  const creation = append("first", { conversation_id: "conversation", generation: 1, state: "running", cwd: "/original", isolation: "shared", git_commit_result: { success: false } });
  let state = applyIncremental(db, 0);
  const correction = append("corrected", { cwd: "/corrected", launch: { model: { model: "model" } } }, creation.fact_id);
  state = applyIncremental(db, state.last_seq);
  assert.equal(state.last_seq, correction.seq);
  const records = () => db.prepare("SELECT data FROM entity_records WHERE entity = 'run'").all().map((row) => JSON.parse(String(row.data)));
  assert.deepEqual(records(), projectEntityRecords(ledger.readSince(0, 10), "run"));
  const before = records();
  rebuild(db); assert.deepEqual(records(), before);
  for (const [sql, expected] of [
    ["SELECT data FROM entity_records WHERE entity = 'run' AND id = 'target'", "PRIMARY KEY"],
    ["SELECT data FROM entity_records INDEXED BY entity_conversation WHERE entity = 'run' AND conversation_id = 'conversation'", "entity_conversation"],
    ["SELECT * FROM artifacts WHERE run_id = 'target'", "artifacts_run_version"],
    ["SELECT * FROM findings WHERE artifact_id = 'target'", "findings_artifact"],
  ]) assert.ok(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().some((row) => String(row.detail).includes(expected)), sql);
  const oldGeneration = Number(db.prepare("SELECT generation FROM projection_state").get()!.generation);
  db.exec("UPDATE runner_projection_version SET version = 0; DELETE FROM entity_records");
  const reopened = new DatabaseSync(path);
  try {
    const restored = applyIncremental(reopened, state.last_seq);
    assert.equal(restored.generation, oldGeneration + 1);
    assert.deepEqual(records(), before);
  } finally { reopened.close(); }
});
