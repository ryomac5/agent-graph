import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FactInput } from "../../src/ledger/facts.ts";
import { openLedger } from "../../src/ledger/ledger.ts";
import { projectMessages } from "../../src/ledger/projections/messages.ts";
import { projectRelations, resolveRelationTarget } from "../../src/ledger/projections/relations.ts";
import { rebuild } from "../../src/ledger/rebuild.ts";

const readSample = (name: string) => JSON.parse(readFileSync(new URL(`../samples/S14/${name}.json`, import.meta.url), "utf8"));
test("S14: correction keeps original facts and gives history, screen and operations the same target across replay and rebuild", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "s14-"));
  const path = join(directory, "ledger.db");
  const ledger = openLedger(path);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = readSample("input") as FactInput[];
  for (const entry of input) assert.equal(ledger.append(entry).status, "appended");
  for (const entry of input) assert.equal(ledger.append(entry).status, "duplicate");
  const facts = ledger.readSince(0, 1000);
  assert.deepEqual(facts.map(({ kind, subject }) => ({ kind, subject })), readSample("expected-ledger"));
  assert.equal(facts.find((entry) => entry.kind === "relation.created")!.payload!.to_id, "wrong");
  const expected = readSample("expected-projection");
  const relations = projectRelations(facts);
  assert.equal(relations.length, 1);
  for (let offset = 0; offset < facts.length; offset += 1) {
    const shuffled = [...facts.slice(offset), ...facts.slice(0, offset)].reverse();
    assert.deepEqual(projectRelations(shuffled), relations);
    const history = projectMessages(shuffled).message_memberships[0].conversation_id;
    const target = resolveRelationTarget(shuffled, "merged");
    assert.deepEqual({ from_id: relations[0].from_id, to_id: relations[0].to_id, confidence: relations[0].confidence,
      active: relations[0].active, history_conversation_id: history, operation_conversation_id: target,
      operation_run_id: "correct" }, expected);
    assert.equal(resolveRelationTarget(shuffled, relations[0].id), target);
  }
  const db = new DatabaseSync(path);
  try {
    rebuild(db);
    const rows = db.prepare("SELECT from_id, to_id, confidence, active FROM relations").all();
    assert.deepEqual(rows.map((entry) => ({ ...entry, active: Boolean(entry.active) })),
      [{ from_id: expected.from_id, to_id: expected.to_id, confidence: expected.confidence, active: expected.active }]);
    rebuild(db); assert.deepEqual(db.prepare("SELECT from_id, to_id, confidence, active FROM relations").all(), rows);
  } finally { db.close(); }
});
