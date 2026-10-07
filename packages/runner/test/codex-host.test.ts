import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { CodexHost } from "../src/hosts/codex/index.ts";
import type { HostEvent, HostFact, RunHandle, StartRequest } from "../src/host/contract.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectMessages } from "../../core/src/ledger/projections/messages.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { createNativeId } from "../../core/src/ledger/projections/relations.ts";
import { Supervisor } from "../src/supervisor.ts";

const TEST_TIMEOUT_MS = 10_000;
function createFixture(t: TestContext, descendant = false) {
  const directory = mkdtempSync(join(tmpdir(), "codex-host-"));
  const log = join(directory, "rpc.jsonl");
  const host = new CodexHost({ executable: process.execPath,
    executableArgs: [fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url))],
    env: { FAKE_APP_SERVER_LOG: log, ...(descendant ? { FAKE_APP_SERVER_DESCENDANT: "1" } : {}) } });
  t.after(async () => { await host.dispose(); rmSync(directory, { force: true, recursive: true }); });
  return { host, directory, readLog: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) };
}
function createRequest(runId: string, text: string): StartRequest {
  return { runId, conversationId: `conversation-${runId}`, generation: 1, cwd: tmpdir(), input: { text }, model: { model: "fake", effort: "low" } };
}
function collect(handle: RunHandle) {
  const events: HostEvent[] = [];
  const waiters = new Set<() => void>();
  const finished = (async () => {
    for await (const event of handle.events) { events.push(event); for (const wake of waiters) wake(); }
  })();
  return { events, finished, async wait(predicate: (events: HostEvent[]) => boolean) {
    if (predicate(events)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake); reject(new Error("Host event timeout")); }, TEST_TIMEOUT_MS / 2);
      const wake = () => { if (predicate(events)) { clearTimeout(timer); waiters.delete(wake); resolve(); } };
      waiters.add(wake);
    });
  } };
}
function facts(events: HostEvent[]): HostFact[] { return events.flatMap((event) => event.type === "fact" ? [event.fact] : []); }
function hasState(events: HostEvent[], state: string): boolean {
  if (state === "failed" && events.some((event) => event.type === "exit" && event.exitCode !== 0)) return true;
  return facts(events).some((fact) => fact.kind === "run.state_changed" && fact.payload.state === state);
}
function hasFinal(events: HostEvent[], text: string): boolean {
  return facts(events).some((fact) => fact.kind === "message.created" && fact.payload.phase === "final_answer" && fact.payload.body === text);
}

test("one stdio server multiplexes two threads and approval IDs including zero", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const [a, b] = await Promise.all([host.start(createRequest("a", "approval")), host.start(createRequest("b", "file-approval"))]);
  assert.equal(a.pid, b.pid);
  assert.notEqual(a.nativeId, b.nativeId);
  const first = collect(a); const second = collect(b);
  await Promise.all([first.wait((events) => facts(events).some((fact) => fact.kind === "approval.created")),
    second.wait((events) => facts(events).some((fact) => fact.kind === "approval.created"))]);
  for (const stream of [first, second]) assert.ok(hasState(stream.events, "waiting_approval"));
  const approvalA = facts(first.events).find((fact) => fact.kind === "approval.created")!;
  const approvalB = facts(second.events).find((fact) => fact.kind === "approval.created")!;
  assert.notEqual(approvalA.subject, approvalB.subject);
  await assert.rejects(host.answer(approvalA.subject.slice(9), "not-offered"), /not offered/);
  await host.answer(approvalB.subject.slice(9), { decision: "cancel" });
  await host.answer(approvalA.subject.slice(9), "accept");
  await Promise.all([first.wait((events) => hasFinal(events, "APPROVED")), second.wait((events) => hasFinal(events, "DENIED"))]);
  for (const stream of [first, second]) {
    const fs = facts(stream.events);
    assert.ok(fs.findIndex((fact) => fact.kind === "approval.answered") < fs.findIndex((fact) => fact.kind === "approval.resolved"));
    assert.equal(fs.filter((fact) => fact.kind === "message.created").length, 2);
    assert.ok(stream.events.some((event) => event.type === "delta"));
  }
  assert.ok(first.events.every((event) => event.type !== "delta" || event.conversationId === "conversation-a"));
  assert.ok(second.events.every((event) => event.type !== "delta" || event.conversationId === "conversation-b"));
  const log = readLog();
  assert.equal(log.filter((message) => message.method === "initialize").length, 1);
  assert.equal(log.filter((message) => message.method === "initialized").length, 1);
  assert.ok(log.filter((message) => message.method === "thread/start").every((message) => message.params.ephemeral === false));
  assert.ok(log.filter((message) => message.method === "turn/start").every((message) => message.params.model === "fake" && message.params.effort === "low"));
  assert.deepEqual(log.filter((message) => message.result).map((message) => message.id).sort(), [0, 1]);
  await host.close("a");
  assert.deepEqual(await host.listModels(), [{ model: "fake", displayName: "Fake", effort: "low" }]);
  await host.close("b");
  await Promise.all([first.finished, second.finished]);
});

test("interrupt records the turn; idle model changes apply to the next turn", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const handle = await host.start(createRequest("interrupt", "hold"));
  const stream = collect(handle);
  await stream.wait((events) => hasState(events, "running"));
  await assert.rejects(host.setModel("interrupt", { model: "other" }), /during a turn/);
  await assert.rejects(host.send("interrupt", { text: "overlap" }), /already active/);
  await host.interrupt("interrupt");
  await stream.wait((events) => facts(events).some((fact) => fact.kind === "run.state_changed" && fact.payload.last_evidence !== null
    && typeof fact.payload.last_evidence === "object" && !Array.isArray(fact.payload.last_evidence) && fact.payload.last_evidence?.status === "interrupted"));
  await host.setModel("interrupt", { model: "other", effort: "high" });
  await host.send("interrupt", { text: "NEXT" });
  await stream.wait((events) => hasFinal(events, "NEXT"));
  const fs = facts(stream.events);
  const interrupt = fs.find((fact) => fact.kind === "run.interrupt_requested");
  assert.ok(interrupt && interrupt.kind === "run.interrupt_requested");
  const rpc = readLog().find((message) => message.method === "turn/interrupt");
  assert.equal(rpc.params.turnId, interrupt.payload.turn_id);
  const turn = readLog().filter((message) => message.method === "turn/start").at(-1);
  assert.equal(turn.params.model, "other"); assert.equal(turn.params.effort, "high");
});

test("output schema is sent with every turn of the run and omitted otherwise", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const schema = { type: "object", additionalProperties: false, required: ["verdict"], properties: { verdict: { type: "string" } } };
  const constrained = await host.start({ ...createRequest("constrained", "READY"), outputSchema: schema });
  const stream = collect(constrained);
  await stream.wait((events) => hasFinal(events, "READY") && hasState(events, "idle"));
  await host.send("constrained", { text: "NEXT" });
  await stream.wait((events) => hasFinal(events, "NEXT"));
  const plain = await host.start(createRequest("plain", "READY"));
  await collect(plain).wait((events) => hasFinal(events, "READY"));
  const turns = readLog().filter((message) => message.method === "turn/start");
  const threads = new Map([[constrained.nativeId, "constrained"], [plain.nativeId, "plain"]]);
  const byRun = (run: string) => turns.filter((turn) => threads.get(turn.params.threadId) === run);
  assert.equal(byRun("constrained").length, 2);
  assert.ok(byRun("constrained").every((turn) => JSON.stringify(turn.params.outputSchema) === JSON.stringify(schema)));
  assert.ok(byRun("plain").every((turn) => !("outputSchema" in turn.params)));
});

test("resume and fork exclude history; fork explicitly selects model and records its source", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const original = await host.start(createRequest("original", "READY"));
  const stream = collect(original);
  await stream.wait((events) => hasFinal(events, "READY"));
  await host.close("original");
  const resumed = await host.resume({ ...createRequest("resumed", "hold"), nativeId: original.nativeId });
  assert.equal(resumed.nativeId, original.nativeId);
  const forked = await host.fork({ ...createRequest("forked", "hold"), nativeId: resumed.nativeId, model: { model: "chosen", effort: "high" } });
  const forkStream = collect(forked);
  await forkStream.wait((events) => facts(events).some((fact) => fact.kind === "relation.created"));
  const resumeRpc = readLog().find((message) => message.method === "thread/resume");
  const forkRpc = readLog().find((message) => message.method === "thread/fork");
  assert.equal(resumeRpc.params.excludeTurns, true);
  assert.equal(forkRpc.params.excludeTurns, true);
  assert.equal(forkRpc.params.model, "chosen");
  const relation = facts(forkStream.events).find((fact) => fact.kind === "relation.created")!;
  assert.ok(relation.kind === "relation.created");
  assert.equal(relation.payload.type, "forked");
  assert.equal(relation.payload.from_id, "conversation-resumed");
  assert.equal(readLog().filter((message) => message.method === "thread/start").length, 1);
});

test("forking an unknown source records only its relation without inventing a conversation or run", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const nativeId = "observed-source";
  const forked = await host.fork({ ...createRequest("unknown-source-fork", "FORKED"), nativeId,
    model: { model: "chosen", effort: "high" } });
  const stream = collect(forked);
  await stream.wait((events) => hasFinal(events, "FORKED"));
  await host.close(forked.runId);
  await host.dispose();
  await stream.finished;
  const fs = facts(stream.events);
  const relations = fs.filter((fact) => fact.kind === "relation.created");
  assert.equal(relations.length, 1);
  const relation = relations[0];
  assert.ok(relation.kind === "relation.created");
  assert.equal(relation.payload.type, "forked");
  assert.equal(relation.payload.from_id, createNativeId("codex", nativeId));
  assert.equal(relation.payload.to_id, "conversation-unknown-source-fork");
  assert.equal(relation.confidence, "confirmed");
  assert.deepEqual(relation.payload.evidence, { forkedFromId: nativeId });
  assert.ok(!fs.some((fact) => fact.kind === "conversation.created" || fact.kind === "run.created"));
  assert.ok(!fs.some((fact) => fact.subject === `conversation:${createNativeId("codex", nativeId)}`));
  const rpc = readLog().find((message) => message.method === "thread/fork");
  assert.equal(rpc.params.threadId, nativeId);
  assert.equal(rpc.params.excludeTurns, true);
  assert.equal(rpc.params.model, "chosen");
});

test("closing the last run leaves the shared server available for a new start", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const original = await host.start(createRequest("closed", "hold"));
  const first = collect(original);
  await host.close("closed");
  await first.finished;
  await assert.rejects(host.send("closed", { text: "CLOSED" }), /closed run/);
  const next = await host.start(createRequest("next", "NEXT"));
  const second = collect(next);
  await second.wait((events) => hasFinal(events, "NEXT"));
  assert.equal(original.pid, next.pid);
  assert.equal(readLog().filter((message) => message.method === "initialize").length, 1);
});

test("server exit expires approvals and reconnects for concurrent start and resume", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t, true);
  const original = await host.start(createRequest("before-crash", "approval"));
  const first = collect(original);
  await first.wait((events) => facts(events).some((fact) => fact.kind === "approval.created"));
  const approval = facts(first.events).find((fact) => fact.kind === "approval.created")!;
  const crashing = collect(await host.start(createRequest("crashing", "crash")));
  await Promise.all([first.finished, crashing.finished]);
  for (const stream of [first, crashing]) assert.ok(hasState(stream.events, "failed"));
  assert.ok(facts(first.events).some((fact) => fact.kind === "approval.resolved" && fact.payload.state === "expired"));
  await assert.rejects(host.send("before-crash", { text: "OLD" }), /closed run/);
  const [resumed, started] = await Promise.all([
    host.resume({ ...createRequest("resumed-crash", "approval"), nativeId: original.nativeId }),
    host.start(createRequest("started-crash", "RECOVERED")),
  ]);
  assert.notEqual(resumed.pid, original.pid);
  assert.equal(resumed.pid, started.pid);
  assert.equal(resumed.nativeId, original.nativeId);
  const oldDescendant = readLog().find((message) => message.descendantPid).descendantPid;
  for (const pid of [original.pid!, oldDescendant]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const resumedStream = collect(resumed); const startedStream = collect(started);
  await resumedStream.wait((events) => facts(events).some((fact) => fact.kind === "approval.created"));
  const newApproval = facts(resumedStream.events).find((fact) => fact.kind === "approval.created")!;
  assert.notEqual(newApproval.subject, approval.subject);
  await assert.rejects(host.answer(approval.subject.slice(9), "accept"), /not pending/);
  await host.answer(newApproval.subject.slice(9), "accept");
  await Promise.all([resumedStream.wait((events) => hasFinal(events, "APPROVED")),
    startedStream.wait((events) => hasFinal(events, "RECOVERED"))]);
  assert.equal(readLog().filter((message) => message.method === "initialize").length, 2);
  assert.equal(readLog().filter((message) => message.method === "initialized").length, 2);
});

test("execpolicy amendment round trips the recorded choice without updatedInput", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const stream = collect(await host.start(createRequest("amendment", "amendment-approval")));
  await stream.wait((events) => facts(events).some((fact) => fact.kind === "approval.created"));
  const approval = facts(stream.events).find((fact) => fact.kind === "approval.created")!;
  assert.ok(approval.kind === "approval.created");
  const selected = approval.payload.available_decisions![1];
  const expected = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["sleep", "2"] } };
  assert.equal(selected, JSON.stringify(expected));
  await host.answer(approval.subject.slice(9), { decision: selected, updatedInput: { command: "ignored" } });
  await stream.wait((events) => hasFinal(events, "APPROVED"));
  assert.deepEqual(readLog().find((message) => message.result), { id: 0, result: { decision: expected } });
  const fs = facts(stream.events);
  assert.ok(fs.some((fact) => fact.kind === "approval.answered" && fact.payload.decision === selected));
  assert.ok(fs.some((fact) => fact.kind === "approval.resolved" && fact.payload.state === "resolved"));
});

test("server requests for a closed run receive an error", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t);
  const first = collect(await host.start(createRequest("closed-request", "hold")));
  await host.close("closed-request");
  await first.finished;
  const active = collect(await host.start(createRequest("request-carrier", "late-approval")));
  await active.wait((events) => hasFinal(events, "ERROR-REPLIED"));
  assert.deepEqual(readLog().find((message) => message.error), { id: 0, error: { code: -32000, message: "Run is closed" } });
  assert.ok(!facts(active.events).some((fact) => fact.kind === "approval.created"));
});

test("a failed turn preserves error evidence and allows another turn", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host } = createFixture(t);
  const stream = collect(await host.start(createRequest("failed-turn", "failed-turn")));
  await stream.wait((events) => facts(events).some((fact) => fact.kind === "run.state_changed"
    && JSON.stringify(fact.payload.last_evidence).includes('"status":"failed"')));
  assert.ok(!hasState(stream.events, "failed"));
  await host.send("failed-turn", { text: "RETRY" });
  await stream.wait((events) => hasFinal(events, "RETRY"));
});

test("thread status maps input and unloaded; system error fails only its run", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host } = createFixture(t);
  const stream = collect(await host.start(createRequest("states", "states")));
  await stream.wait((events) => hasState(events, "failed") && hasState(events, "unknown"));
  const states = facts(stream.events).flatMap((fact) => fact.kind === "run.state_changed" ? [fact.payload.state] : []);
  assert.deepEqual(states, ["idle", "running", "running", "waiting_input", "unknown"]);
  const exit = stream.events.find((event) => event.type === "exit");
  assert.ok(exit?.type === "exit" && exit.exitCode === 1 && exit.cause?.includes("systemError"));
  const other = collect(await host.start(createRequest("other", "STILL-ALIVE")));
  await other.wait((events) => hasFinal(events, "STILL-ALIVE"));
});

test("systemError remains failed through supervisor and core projection", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, directory } = createFixture(t);
  const ledger = openLedger(join(directory, "failure.db"));
  try {
    const supervisor = new Supervisor(ledger);
    supervisor.registerHost(host);
    await supervisor.start("codex", createRequest("projected-failure", "states"));
    await supervisor.wait("projected-failure");
    const run = projectRuns(ledger.readSince(0, 1000))[0];
    assert.equal(run.state, "failed");
    assert.ok(run.cause?.includes("systemError"));
  } finally { ledger.close(); }
});

test("interrupt expires pending approvals and prevents a late answer", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host } = createFixture(t);
  const stream = collect(await host.start(createRequest("pending", "approval")));
  await stream.wait((events) => facts(events).some((fact) => fact.kind === "approval.created"));
  const approval = facts(stream.events).find((fact) => fact.kind === "approval.created")!;
  await host.interrupt("pending");
  await stream.wait((events) => facts(events).some((fact) => fact.kind === "approval.resolved" && fact.payload.state === "expired"));
  await assert.rejects(host.answer(approval.subject.slice(9), "accept"), /not pending/);
});

test("completion before turn/start response permits the next turn", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host } = createFixture(t);
  const stream = collect(await host.start(createRequest("early", "early-completion")));
  await stream.wait((events) => hasFinal(events, "early-completion"));
  await host.setModel("early", { model: "next" });
  await host.send("early", { text: "FOLLOWUP" });
  await stream.wait((events) => hasFinal(events, "FOLLOWUP"));
});

test("S19 preserves child facts before a confirmed delegated relation", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, directory } = createFixture(t);
  const stream = collect(await host.start(createRequest("parent", "S19")));
  await stream.wait((events) => hasFinal(events, "PARENT-OK"));
  const fs = facts(stream.events);
  const childId = JSON.stringify(["codex", "child-S19"]);
  const child = fs.find((fact) => fact.kind === "conversation.created" && fact.payload.native_id === "child-S19")!;
  const childMessage = fs.find((fact) => fact.kind === "message.created" && fact.payload.body === "CHILD-OK")!;
  const relation = fs.find((fact) => fact.kind === "relation.created")!;
  assert.ok(child.kind === "conversation.created" && relation.kind === "relation.created");
  assert.equal(child.subject, `conversation:${childId}`);
  assert.ok(fs.indexOf(childMessage) < fs.indexOf(relation));
  assert.equal(relation.payload.type, "delegated");
  assert.equal(relation.payload.from_id, "conversation-parent");
  assert.equal(relation.payload.to_id, childId);
  assert.equal(relation.confidence, "confirmed");
  assert.deepEqual(relation.payload.evidence, { item_id: "spawn-S19" });
  assert.equal(fs.filter((fact) => fact.kind === "relation.created").length, 1);
  assert.equal(fs.filter((fact) => fact.kind.endsWith(".corrected")).length, 0);
  assert.ok(stream.events.some((event) => event.type === "delta" && event.conversationId === childId));
  const ledger = openLedger(join(directory, "sample.db"));
  try {
    for (const fact of fs) assert.equal(ledger.append({ ...fact, source: "host-codex" }).status, "appended");
    const projected = projectMessages(ledger.readSince(0, 1000));
    assert.ok(projected.message_memberships.some((membership) => membership.conversation_id === childId));
  } finally { ledger.close(); }
});

test("shutdown closes stdin and kills the dedicated process group including descendants", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { host, readLog } = createFixture(t, true);
  const handle = await host.start(createRequest("shutdown", "hold"));
  const stream = collect(handle);
  await host.dispose();
  await stream.finished;
  const descendant = readLog().find((message) => message.descendantPid).descendantPid;
  for (const pid of [handle.pid!, descendant]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(host.listModels(), /closed/);
});
