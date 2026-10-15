import assert from "node:assert/strict";
import { test } from "node:test";
import { selectEvidence } from "../../src/state/evidence.ts";
import { checkOrders, scan, signal } from "./helpers.ts";

test("evidence identity and order ignore JSON key order, including nested fields", () => {
  const original = scan(10);
  const reordered = { hosted: original.hosted, processes: original.processes!.map(p => ({ procStart: p.procStart, pid: p.pid })),
    validForMs: original.validForMs, status: original.status, subjects: original.subjects, scope: original.scope, source: original.source,
    observedAt: original.observedAt, at: original.at, id: original.id, kind: original.kind };
  const evidence = [original, reordered, { ...reordered, observedAt: 20 }, signal("progress", 10, { id: "a" })];
  assert.deepEqual(selectEvidence(evidence, 30).map(e => e.id), ["a", original.id]);
  assert.equal(selectEvidence(evidence, 30)[1].observedAt, 10);
  checkOrders(evidence, evidence => selectEvidence(evidence, 30));
});
