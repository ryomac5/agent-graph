import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { openLedger } from "../../core/src/ledger/index.ts";
import type { FactInput } from "../../core/src/ledger/facts.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { rebuild } from "../../core/src/ledger/rebuild.ts";
import { initializeSchema } from "../../core/src/ledger/schema.ts";
import { FakeHost, type HostEvent, type ResumeRequest } from "../src/host/contract.ts";
import { Recovery } from "../src/recovery.ts";

const sample = JSON.parse(readFileSync(new URL("./samples/S12/input.json", import.meta.url), "utf8")) as { facts: FactInput[]; events: HostEvent[] };
const expected = JSON.parse(readFileSync(new URL("./samples/S12/expected.json", import.meta.url), "utf8"));
const getRequest = () => ({ cwd: "/sample", model: { model: "fake" } });

for (const reverse of [false, true]) {
  test(`S12: restart, pending approvals, Codex rejoin and Claude resume action (reverse=${reverse})`, async (t) => {
    const ledger = openLedger(":memory:"); t.after(() => ledger.close());
    const input = reverse ? [...sample.facts].reverse() : sample.facts;
    for (const fact of input) ledger.append(fact);
    for (const fact of input) assert.equal(ledger.append(fact).status, "duplicate");
    assert.equal(ledger.readSince(0, 100).length, sample.facts.length);
    const codex = new FakeHost("codex");
    const claude = new FakeHost("claude");
    const requests: ResumeRequest[] = [];
    t.mock.method(codex, "resume", async (request: ResumeRequest) => {
      requests.push(request);
      const handle = await codex.start(request);
      return { ...handle, nativeId: request.nativeId };
    });
    const seqs: number[] = [];
    const recovery = new Recovery(ledger, { hosts: [codex, claude], getRequest,
      publish(event) { if ("seq" in event) { assert.equal(ledger.readSince(event.seq - 1, 1).length, 1); seqs.push(event.seq); } } });
    const result = await recovery.recover();
    const beforeState = projectRuns(ledger.readSince(0, 100));
    assert.equal(beforeState.find((run) => run.conversation_id === "codex")?.state, "unknown");
    assert.equal(claude.starts.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].nativeId, "native-codex");
    assert.equal(requests[0].generation, 1);
    assert.deepEqual(requests[0].input, { text: "" });
    assert.deepEqual(result.actions.map((action) => [action.runId, action.operation]), expected.actions);
    const iterator = result.handles[0].events[Symbol.asyncIterator]();
    for (const event of sample.events) {
      codex.emit("codex", event);
      assert.deepEqual((await iterator.next()).value, event);
    }
    await iterator.return?.();
    const facts = ledger.readSince(0, 100);
    assert.deepEqual(projectRuns(facts).map((run) => [run.conversation_id, run.state]), expected.runs);
    assert.deepEqual(projectApprovals(facts).map((approval) => [approval.id, approval.state]), expected.approvals);
    assert.deepEqual(facts.slice(sample.facts.length).map((fact) => [fact.subject, fact.kind,
      fact.payload && "state" in fact.payload ? fact.payload.state : undefined]), expected.ledger);
    assert.equal(seqs.length, expected.ledger.length);
    assert.deepEqual(projectRuns([...facts].reverse()), projectRuns(facts));
    assert.deepEqual(projectApprovals([...facts].reverse()), projectApprovals(facts));
    assert.strictEqual(await recovery.recover(), result);
    assert.equal(ledger.readSince(0, 100).length, facts.length);
    assert.equal(requests.length, 1);
    const db = new DatabaseSync(":memory:"); t.after(() => db.close());
    initializeSchema(db);
    const insert = db.prepare("INSERT INTO facts (seq, fact_id, source, source_event_id, kind, subject, payload, payload_hash, source_ts, observed_ts, schema_version, cursor, confidence, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const fact of facts) insert.run(fact.seq, fact.fact_id, fact.source, fact.source_event_id, fact.kind, fact.subject,
      JSON.stringify(fact.payload), fact.payload_hash, fact.source_ts, fact.observed_ts, fact.schema_version, fact.cursor, fact.confidence, fact.supersedes);
    rebuild(db);
    assert.deepEqual(db.prepare("SELECT conversation_id, state FROM runs ORDER BY conversation_id").all().map((row) => [row.conversation_id, row.state]), expected.runs);
    assert.deepEqual(db.prepare("SELECT id, state FROM approvals ORDER BY id").all().map((row) => [row.id, row.state]), expected.approvals);
  });
}

for (const failure of ["resume rejected", "wrong native ID", "host unavailable", "request unavailable"]) {
  test(`failed rejoin preserves unknown and exposes retry: ${failure}`, async (t) => {
    const ledger = openLedger(":memory:"); t.after(() => ledger.close());
    for (const fact of sample.facts) ledger.append(fact);
    const host = new FakeHost("codex");
    t.mock.method(host, "resume", async (request: ResumeRequest) => {
      if (failure === "resume rejected") throw new Error("resume rejected");
      return host.start(request);
    });
    const recovery = new Recovery(ledger, { hosts: failure === "host unavailable" ? [] : [host],
      getRequest: failure === "request unavailable" ? () => undefined : getRequest });
    const result = await recovery.recover();
    assert.equal(result.handles.length, 0);
    assert.equal(result.actions.length, 2);
    const facts = ledger.readSince(0, 100);
    assert.equal(projectRuns(facts).find((run) => run.conversation_id === "codex")?.state, "unknown");
    assert.equal(facts.slice(sample.facts.length).some((fact) => fact.kind === "run.state_changed"
      && (fact.payload?.state === "ended" || fact.payload?.state === "failed")), false);
    assert.equal(projectApprovals(facts).find((approval) => approval.id === "codex")?.state, "expired");
  });
}

test("already unknown runs remain eligible for Codex rejoin when the supervisor recovered first", async (t) => {
  const ledger = openLedger(":memory:"); t.after(() => ledger.close());
  for (const fact of sample.facts) ledger.append(fact);
  ledger.append({ source: "host-codex", source_event_id: "prior-restart", source_ts: "2026-01-01T00:00:03Z",
    kind: "run.state_changed", subject: "run:codex", confidence: "confirmed",
    payload: { state: "unknown", reason: "restart", generation: 1 } });
  const host = new FakeHost("codex");
  t.mock.method(host, "resume", async (request: ResumeRequest) => ({ ...await host.start(request), nativeId: request.nativeId }));
  const result = await new Recovery(ledger, { hosts: [host], getRequest }).recover();
  assert.equal(result.handles.length, 1);
  assert.equal(host.starts.length, 1);
  assert.equal(projectRuns(ledger.readSince(0, 100)).find((run) => run.conversation_id === "codex")?.state, "unknown");
});

test("a host with resume disabled receives no rejoin call", async (t) => {
  const ledger = openLedger(":memory:"); t.after(() => ledger.close());
  for (const fact of sample.facts) ledger.append(fact);
  const host = new FakeHost("codex");
  const capabilities = host.capabilities();
  t.mock.method(host, "capabilities", () => ({ ...capabilities, resume: false }));
  const result = await new Recovery(ledger, { hosts: [host], getRequest }).recover();
  assert.equal(host.starts.length, 0);
  assert.equal(result.handles.length, 0);
  assert.equal(result.actions.find((action) => action.runId === "codex")?.reason, "host_or_request_unavailable");
});

for (const reverse of [false, true]) {
  for (const state of ["running", "unknown", "ended", "failed"] as const) {
    test(`only the latest generation recovers across restarts (state=${state}, reverse=${reverse})`, async (t) => {
      const ledger = openLedger(":memory:"); t.after(() => ledger.close());
      const facts: FactInput[] = sample.facts.filter((fact) => fact.source === "host-claude"
        || fact.subject === "conversation:codex" || fact.subject === "run:codex" || fact.subject === "approval:codex");
      for (const provider of ["claude", "codex"] as const) {
        facts.push({ source: `host-${provider}`, source_event_id: `old-unknown:${provider}`,
          source_ts: "2026-01-01T00:00:03Z", kind: "run.state_changed", subject: `run:${provider}`,
          confidence: "confirmed", payload: { state: "unknown", reason: "restart", generation: 1 } });
        facts.push({ source: `host-${provider}`, source_event_id: `new-run:${provider}`,
          source_ts: "2026-01-01T00:00:04Z", kind: "run.created", subject: `run:${provider}-2`,
          confidence: "confirmed", payload: { conversation_id: provider, generation: 2, state: "running" } });
        facts.push({ source: `host-${provider}`, source_event_id: `new-state:${provider}`,
          source_ts: "2026-01-01T00:00:05Z", kind: "run.state_changed", subject: `run:${provider}-2`,
          confidence: "confirmed", payload: { state, generation: 2,
            ...(state === "ended" || state === "failed"
              ? { end_evidence: { kind: "host_exit", exit_code: state === "ended" ? 0 : 1 }, cause: "sample failure" }
              : {}) } });
        facts.push({ source: `host-${provider}`, source_event_id: `new-approval:${provider}`,
          source_ts: "2026-01-01T00:00:06Z", kind: "approval.created", subject: `approval:${provider}-2`,
          confidence: "confirmed", payload: { run_id: `${provider}-2`, request_id: `request-${provider}-2`, state: "pending" } });
      }
      for (const fact of reverse ? [...facts].reverse() : facts) ledger.append(fact);
      const oldFacts = ledger.readSince(0, 100).filter((fact) => fact.subject === "run:claude" || fact.subject === "run:codex");
      const terminal = state === "ended" || state === "failed";
      for (let restart = 0; restart < 2; restart += 1) {
        const codex = new FakeHost("codex");
        const claude = new FakeHost("claude");
        const requests: ResumeRequest[] = [];
        t.mock.method(codex, "resume", async (request: ResumeRequest) => {
          requests.push(request);
          return { ...await codex.start(request), nativeId: request.nativeId };
        });
        const result = await new Recovery(ledger, { hosts: [codex, claude], getRequest }).recover();
        assert.equal(claude.starts.length, 0);
        assert.equal(requests.length, terminal ? 0 : 1);
        assert.equal(result.handles.length, terminal ? 0 : 1);
        assert.deepEqual(result.actions.map((action) => [action.runId, action.generation, action.operation]),
          terminal ? [] : [["claude-2", 2, "resume"]]);
        if (!terminal) {
          assert.equal(requests[0].runId, "codex-2");
          assert.equal(requests[0].generation, 2);
          assert.equal(requests[0].nativeId, "native-codex");
          const iterator = result.handles[0].events[Symbol.asyncIterator]();
          codex.emit("codex-2", { type: "state", state: "idle" });
          await iterator.next();
          await iterator.return?.();
        }
        const recoveredFacts = ledger.readSince(0, 100);
        assert.deepEqual(recoveredFacts.filter((fact) => fact.subject === "run:claude" || fact.subject === "run:codex"), oldFacts);
        assert.deepEqual(projectRuns(recoveredFacts).map((run) => [run.conversation_id, run.generation, run.state]), [
          ["claude", 1, "unknown"], ["claude", 2, terminal ? state : "unknown"],
          ["codex", 1, "unknown"], ["codex", 2, terminal ? state : "idle"],
        ]);
        assert.equal(projectApprovals(recoveredFacts).every((approval) => approval.state === "expired"), true);
      }
    });
  }
}
