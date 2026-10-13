import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openObservationService } from "../src/service/index.ts";
import { observeKitDelegationsFile } from "../src/observe/kit/delegations.ts";
import { createServeSettings } from "../src/ws/settings.ts";
import type { RunnerClient } from "../src/runner-client.ts";
import { defaultPolicy, getCandidates } from "../../core/src/assign/policy.ts";
import { POLICY_HISTORY_LIMIT } from "../src/settings/policy-preview.ts";
import type { FactPayloads } from "../../core/src/ledger/facts.ts";
import { readLedgerDatabase } from "../../core/src/ledger/repository.ts";

test("serve preview reads kit descriptions/tasks and ledger titles with source dates, hiding kit fallback names", async () => {
  const root = await mkdtemp(join(tmpdir(), "policy-preview-history-"));
  const observation = openObservationService({ dbPath: join(root, "ledger.db") });
  const runner = { available: false } as RunnerClient;
  const configured = createServeSettings(observation, { repository: root, runner, resync() {},
    keychain: { async setClaudeApiKey() {}, async deleteClaudeApiKey() {}, async hasClaudeApiKey() { return false; } } });
  try {
    const path = join(root, "events.jsonl");
    const events = [
      { ts: "2026-10-12T18:30:00+0900", event: "codex_start", session: "fixture", node_id: "codex-01", description: "Improve settings preview", task: "Longer task" },
      { ts: "2026-10-12T09:20:00Z", event: "codex_start", session: "fixture", node_id: "codex-02", task: "Fix request summaries" },
      { ts: "2026-10-12T18:10:00+09:00", event: "codex_start", session: "fixture", node_id: "codex-03" },
    ].map(event => JSON.stringify(event) + "\n").join("");
    await writeFile(path, events);
    observeKitDelegationsFile(observation.ledger, path);
    for (const [index, role] of (["implement", "research"] as const).entries()) {
      const request = { role, title: "Ledger request title", task: "Ledger task", accept: [] };
      const payload = { ...request, request_id: `ledger-${index}`, request, attempt: 1, state: "received" as const };
      observation.ledger.append({ source: "intake", source_event_id: `request-${index}`, source_ts: `2026-10-12T09:0${index}:00Z`,
        kind: "delegation.created", subject: `delegation:ledger-${index}`, confidence: "confirmed",
        payload });
    }
    observation.ledger.append({ source: "legacy", source_event_id: "flat-request", source_ts: "2026-10-12T08:00:00Z",
      kind: "delegation.created", subject: "delegation:flat", confidence: "confirmed",
      payload: { request_id: "flat", role: "implement", title: "Older ledger request", task: "Older task", attempt: 0, state: "received" } });
    const factsBefore = observation.ledger.readSince(0, 1000).length;
    const policy = defaultPolicy();
    const preview = configured.settings.previewPolicy({ roles: { implement: [...getCandidates(policy, "implement")].reverse() } });
    assert.equal(preview.total, 6);
    assert.equal(preview.changed, 5);
    assert.deepEqual(preview.rows.map(row => row.description), ["Improve settings preview", "Fix request summaries", "", "Ledger request title", "Older ledger request"]);
    assert.deepEqual(preview.rows.slice(0, 3).map(row => row.timestamp), ["2026-10-12T09:30:00.000Z", "2026-10-12T09:20:00.000Z", "2026-10-12T09:10:00.000Z"]);
    assert.ok(preview.rows.every(row => row.role === "implement"));
    assert.deepEqual(preview.roleChanges.map(change => change.role), ["implement"]);
    assert.equal(observation.ledger.readSince(0, 1000).length, factsBefore);
    assert.equal(await readFile(path, "utf8"), events);
  } finally {
    configured.close(); observation.close(); await rm(root, { recursive: true, force: true });
  }
});

test("serve preview selects the newest 100 requests across mixed offsets and out-of-order imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "policy-preview-history-"));
  const observation = openObservationService({ dbPath: join(root, "ledger.db") });
  const configured = createServeSettings(observation, { repository: root, runner: { available: false } as RunnerClient, resync() {},
    keychain: { async setClaudeApiKey() {}, async deleteClaudeApiKey() {}, async hasClaudeApiKey() { return false; } } });
  try {
    const olderCount = 20;
    const requestCount = POLICY_HISTORY_LIMIT + olderCount;
    function readTimestamp(index: number, offset: string): string {
      const hour = offset === "Z" ? "09" : "18";
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      return `2026-10-13T${hour}:${minute}:${second}${offset}`;
    }
    const path = join(root, "events.jsonl");
    const kitIndexes = Array.from({ length: POLICY_HISTORY_LIMIT / 2 }, (_, index) => olderCount + index * 2 + 1);
    await writeFile(path, kitIndexes.map(index => JSON.stringify({ ts: readTimestamp(index, "+0900"),
      event: "codex_start", session: "fixture", node_id: `kit-${index}`, description: `Request ${index}` }) + "\n").join(""));
    observeKitDelegationsFile(observation.ledger, path);
    // 古い legacy を最後に取り込み、seq と source_ts の順序を逆転させる。
    for (const source of ["intake", "legacy"] as const) {
      for (let index = 0; index < requestCount; index += 1) {
        if (source === "intake" ? index < olderCount || index % 2 !== 0 : index >= olderCount) continue;
        const request = { role: index < olderCount ? "research" : "implement", title: `Request ${index}`, task: `Task ${index}`, accept: [] };
        observation.ledger.append({ source, source_event_id: `request-${index}`, source_ts: readTimestamp(index, source === "intake" && index % 4 !== 0 ? "+09:00" : "Z"),
          kind: "delegation.created", subject: `delegation:${index}`, confidence: "confirmed",
          payload: { ...request, request_id: String(index), attempt: 1, state: "received" } });
      }
    }
    // append の正規化を迂回し、補完前の本番に残る生の時差表記を再現する。
    const db = readLedgerDatabase(observation.ledger);
    db.exec(`UPDATE facts SET source_ts = strftime('%Y-%m-%dT%H:%M:%S', source_ts, '+9 hours') || '+0900' WHERE source = 'kit';
      UPDATE facts SET source_ts = strftime('%Y-%m-%dT%H:%M:%S', source_ts, '-5 hours') || '-0500' WHERE source = 'legacy'`);
    assert.equal(db.prepare("SELECT count(*) AS count FROM facts WHERE source = 'kit' AND kind = 'delegation.created' AND julianday(source_ts) IS NULL").get()!.count, kitIndexes.length);
    const policy = defaultPolicy();
    const preview = configured.settings.previewPolicy({ roles: { implement: [...getCandidates(policy, "implement")].reverse() } });
    assert.equal(preview.total, POLICY_HISTORY_LIMIT);
    assert.equal(preview.changed, POLICY_HISTORY_LIMIT);
    assert.deepEqual(preview.rows.map(row => row.description), [119, 118, 117, 116, 115].map(index => `Request ${index}`));
    assert.deepEqual(preview.rows.map(row => row.timestamp), [119, 118, 117, 116, 115].map(index => index % 2
      ? readTimestamp(index, "+0900") : readTimestamp(index, "Z").replace("Z", ".000Z")));
    // 境界の依頼だけを変更対象から外し、101 件目が代わりに入らないことも確かめる。
    observation.ledger.append({ source: "intake", source_event_id: "boundary-update", source_ts: readTimestamp(olderCount, "+09:00"),
      kind: "delegation.created", subject: "delegation:boundary", confidence: "confirmed",
      payload: { request_id: "boundary", role: "research", title: "Boundary request", task: "Boundary task", accept: [], attempt: 1, state: "received" } });
    const boundary = configured.settings.previewPolicy({ roles: { implement: [...getCandidates(policy, "implement")].reverse() } });
    assert.equal(boundary.total, POLICY_HISTORY_LIMIT);
    assert.equal(boundary.changed, POLICY_HISTORY_LIMIT - 1);
  } finally {
    configured.close(); observation.close(); await rm(root, { recursive: true, force: true });
  }
});

test("serve preview preserves request constraints in flat, nested and migrated legacy payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "policy-preview-history-"));
  const observation = openObservationService({ dbPath: join(root, "ledger.db") });
  const configured = createServeSettings(observation, { repository: root, runner: { available: false } as RunnerClient, resync() {},
    keychain: { async setClaudeApiKey() {}, async deleteClaudeApiKey() {}, async hasClaudeApiKey() { return false; } } });
  try {
    const request = { role: "implement", title: "Constrained request", task: "Task", accept: [], constraints: { excludeFamily: ["openai"] } };
    const payloads: (Omit<FactPayloads["delegation.created"], "attempt" | "state"> & { request?: typeof request })[] = [
      { ...request, request_id: "flat" },
      { ...request, request_id: "nested", constraints: {}, request },
      { ...request, request_id: "legacy", constraints: { legacy_kind: "delegation", legacy_parent_id: null, request, outputs: [] } },
      { ...request, request_id: "unconstrained", constraints: {} },
    ];
    for (const payload of payloads) observation.ledger.append({ source: "legacy", source_event_id: payload.request_id,
      source_ts: "2026-10-13T09:00:00Z", kind: "delegation.created", subject: `delegation:${payload.request_id}`, confidence: "confirmed",
      payload: { ...payload, attempt: 0, state: "received" } });
    const policy = defaultPolicy();
    const preview = configured.settings.previewPolicy({ roles: { implement: [...getCandidates(policy, "implement")].reverse() } });
    assert.equal(preview.total, payloads.length);
    assert.equal(preview.changed, 1);
    assert.deepEqual(preview.rows.map(row => row.id), ["unconstrained"]);
  } finally {
    configured.close(); observation.close(); await rm(root, { recursive: true, force: true });
  }
});
