import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FactInput, JsonValue } from "../../core/src/ledger/facts.ts";
import { openObservationService } from "../src/service/index.ts";
import { ProjectionFeed } from "../src/service/projection-feed.ts";
import { forwardScreenCommand } from "../src/ws/commands.ts";
import { REVIEW_COMMANDS } from "../src/ws/contract.ts";

for (const command of REVIEW_COMMANDS) {
  test(`WebSocket forwards ${command} with fixed IDs and unchanged command identity`, () => {
    const payload: JsonValue = { artifactId: "fixed-version", patch_hash: "fixed-patch", findingIds: ["finding"],
      previousArtifactId: "old-version", factId: "original-fact", relationId: "merged", approvalId: "approval" };
    const request = forwardScreenCommand({ type: "cmd", cmd_id: "retry-stable", command, payload });
    assert.deepEqual(request, { type: "req", cmd_id: "retry-stable", command, payload });
    assert.deepEqual(forwardScreenCommand({ type: "cmd", cmd_id: "retry-stable", command, payload }), request);
  });
}

test("S14: API snapshot and patch expose corrected relation while preserving original ledger fact", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "api-review-"));
  const dbPath = join(directory, "ledger.db");
  const service = openObservationService({ dbPath });
  const feed = new ProjectionFeed(dbPath, service.catchUp);
  t.after(() => { feed.close(); service.close(); rmSync(directory, { recursive: true, force: true }); });
  const input = JSON.parse(readFileSync(new URL("../../core/test/samples/S14/input.json", import.meta.url), "utf8")) as FactInput[];
  for (const fact of input.slice(0, -1)) service.ledger.append(fact);
  feed.refresh();
  const before = feed.snapshot();
  service.ledger.append(input.at(-1)!);
  const patch = feed.refresh();
  assert.ok(patch && patch !== "resync");
  assert.equal(patch.changes.relations?.remove.length, 1);
  assert.equal(patch.changes.relations?.upsert[0].to_id, '["codex","correct"]');
  const after = feed.snapshot();
  assert.notDeepEqual(before.projection.relations, after.projection.relations);
  assert.equal(after.projection.relations[0].to_id, '["codex","correct"]');
  assert.equal(service.ledger.readSince(0, 1000).find((fact) => fact.kind === "relation.created")!.payload!.to_id, "wrong");
});
