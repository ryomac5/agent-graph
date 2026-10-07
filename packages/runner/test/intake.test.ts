import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { test, type TestContext } from "node:test";
import { defaultPolicy } from "../../core/src/assign/policy.ts";
import { fingerprintRequest, readOrigin, type IntakeRequest } from "../../core/src/intake/index.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectDelegations, projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { projectRelations } from "../../core/src/ledger/projections/relations.ts";
import { FakeHost } from "../src/host/contract.ts";
import { buildReviewPrompt, parseReviewResult, REVIEW_OUTPUT_SCHEMA } from "../src/intake/review.ts";
import { Intake } from "../src/intake/index.ts";
import { serveIntakeRunner } from "../src/intake/socket.ts";
import { RunnerRuntime } from "../src/runtime.ts";

function fixture(t: TestContext, isolation: "shared" | "worktree" = "shared") {
  const directory = mkdtempSync(join(tmpdir(), "intake-"));
  const cwd = join(directory, "repo"); mkdirSync(cwd);
  function git(...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(cwd, "file.txt"), "base\n"); git("add", "."); git("commit", "-m", "base");
  const ledger = openLedger(join(directory, "ledger.db"), { storageScope: "full_diff" });
  const codex = new FakeHost("codex"); const claude = new FakeHost("claude");
  const runtime = new RunnerRuntime(ledger, [codex, claude], () => {}, isolation);
  const intake = new Intake(ledger, runtime, { cwd, decision: { policy: defaultPolicy(), quota: () => undefined, performance: () => undefined } });
  const request: IntakeRequest = { requestId: "request", source: "planner", role: "implement", title: "Fixture", task: "Make change", accept: ["test -f file.txt"], cwd };
  const previousState = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = join(directory, "state");
  const previousCache = process.env.XDG_CACHE_HOME; process.env.XDG_CACHE_HOME = join(directory, "cache");
  t.after(async () => {
    await intake.close(); ledger.close(); rmSync(directory, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previousState;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
  });
  function observe() {
    return ledger.append({ source: "transcript-claude", source_event_id: "terminal", source_ts: "2026-01-01T00:00:00Z", kind: "conversation.created",
      subject: "conversation:parent", confidence: "confirmed", payload: { provider: "claude", native_id: "terminal-claude", origin: "observed", type: "interactive", history_format: "jsonl" } });
  }
  return { intake, runtime, ledger, codex, claude, request, observe };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for intake");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
function emitReview(host: FakeHost, verdict = "approve", output = JSON.stringify({ verdict, comment: "Checked" })) {
  const req = host.starts.at(-1)!;
  host.emit(req.runId, { type: "fact", fact: { source_event_id: `answer:${req.runId}`, source_ts: new Date().toISOString(),
    kind: "message.created", subject: `message:${req.runId}`, confidence: "confirmed", payload: {
      provider: host.provider, native_id: req.runId, version: 1, role: "assistant", body_state: "stored", body: output } } });
  host.emit(req.runId, { type: "fact", fact: { source_event_id: `membership:${req.runId}`, source_ts: new Date().toISOString(), kind: "message_membership.created", subject: `message_membership:${req.runId}`, confidence: "confirmed", payload: { message_id: req.runId, conversation_id: req.conversationId, active: true } } });
  host.emit(req.runId, { type: "exit", exitCode: 0 });
}

test("durable acceptance precedes start; resends are one delegation and conflicts are rejected", async (t) => {
  const { intake, ledger, codex, request } = fixture(t);
  assert.equal(intake.submit(request).state, "accepted");
  assert.equal(codex.starts.length, 0);
  assert.equal(projectDelegations(ledger.readSince(0, 100)).length, 1);
  assert.equal(intake.submit({ ...request }).state, "accepted");
  assert.throws(() => intake.submit({ ...request, task: "changed" }), /Conflicting/);
  await until(() => intake.status(request.requestId).state === "running");
  assert.equal(codex.starts.length, 1);
  assert.equal(intake.submit(request).state, "running");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 1 });
  assert.equal((await intake.wait(request.requestId)).state, "failed");
  assert.equal(intake.submit(request).state, "failed");
  assert.equal(codex.starts.length, 1);
  assert.equal(intake.retry(request.requestId).attempt, 2);
  await until(() => codex.starts.length === 2);
  assert.equal(projectDelegations(ledger.readSince(0, 1000))[0].attempts.length, 2);
});

test("append failure never starts a host", async (t) => {
  const { intake, ledger, codex, request } = fixture(t);
  const append = ledger.append;
  ledger.append = () => { throw new Error("injected append failure"); };
  assert.throws(() => intake.submit(request), /injected/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(codex.starts.length, 0);
  ledger.append = append;
  assert.equal(intake.submit(request).state, "accepted");
});

test("acceptance and a managed reviewer of another family use a fixed artifact", async (t) => {
  const { intake, ledger, codex, claude, request } = fixture(t, "worktree");
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  assert.notEqual(codex.starts[0].cwd, request.cwd);
  writeFileSync(join(codex.starts[0].cwd, "file.txt"), "updated\n");
  writeFileSync(join(codex.starts[0].cwd, "new.txt"), "new\n");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  const artifacts = projectEntityRecords<{ patch_hash: string; untracked: string[] }>(ledger.readSince(0, 1000), "artifact");
  assert.equal(artifacts.length, 1);
  assert.deepEqual(artifacts[0].untracked, ["new.txt"]);
  assert.ok(claude.starts[0].input.text.includes(artifacts[0].patch_hash!));
  emitReview(claude);
  const status = await intake.wait(request.requestId);
  assert.equal(status.state, "done");
  assert.equal(status.result?.acceptance.passed, true);
  const versions = ledger.readSince(0, 1000).filter((fact) => fact.kind === "artifact.version_created");
  assert.equal(versions.length, 1);
  const fixed = projectEntityRecords<{ verification: { passed: boolean } }>(ledger.readSince(0, 1000), "artifact");
  assert.equal(fixed[0].verification!.passed, true);
  const attempt = projectDelegations(ledger.readSince(0, 1000))[0].attempts[0];
  assert.equal((attempt.review as { artifact_id: string }).artifact_id, fixed[0].id);
  assert.notEqual(status.result?.assignment.family, status.result?.review?.reviewer.family);
  assert.equal(intake.submit(request).state, "done");
  assert.equal(codex.starts.length, 1); assert.equal(claude.starts.length, 1);
});

test("reviewer receives the original request and implementer reply so an empty diff can satisfy a no-change task", async (t) => {
  const { intake, codex, claude, request } = fixture(t);
  const noChange = { ...request, task: "Reply INTAKE-OK. Do not use tools or change files.", accept: ["git diff --exit-code"], scope: ["file.txt"] };
  intake.submit(noChange);
  await until(() => intake.status(request.requestId).state === "running");
  const run = codex.starts[0];
  codex.emit(run.runId, { type: "fact", fact: { source_event_id: `answer:${run.runId}`, source_ts: new Date().toISOString(),
    kind: "message.created", subject: `message:${run.runId}`, confidence: "confirmed", payload: {
      provider: "codex", native_id: run.runId, version: 1, role: "assistant", phase: "final_answer", body_state: "stored", body: "INTAKE-OK" } } });
  codex.emit(run.runId, { type: "fact", fact: { source_event_id: `membership:${run.runId}`, source_ts: new Date().toISOString(), kind: "message_membership.created",
    subject: `message_membership:${run.runId}`, confidence: "confirmed", payload: { message_id: run.runId, conversation_id: run.conversationId, active: true } } });
  codex.emit(run.runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  const prompt = claude.starts[0].input.text;
  assert.ok(prompt.includes(JSON.stringify(noChange.task)), "review prompt carries the original task");
  assert.ok(prompt.includes('"accept":["git diff --exit-code"]') && prompt.includes('"scope":["file.txt"]'));
  assert.match(prompt, /Implementer reply:\nINTAKE-OK\n/);
  assert.match(prompt, /empty diff is correct when the task asks for no file changes/);
  assert.ok(prompt.includes('"patch_hash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"'), "artifact is the empty diff");
  assert.deepEqual(claude.starts[0].outputSchema, REVIEW_OUTPUT_SCHEMA, "reviewer output is constrained by the host");
  assert.equal(codex.starts[0].outputSchema, undefined, "implementer output stays free text");
  emitReview(claude);
  assert.equal((await intake.wait(request.requestId)).state, "done");
});

test("free-text review JSON with unescaped quotes is unreadable, so the verdict must come from the constrained output", () => {
  // 実機の試験で haiku が返した本文。承認でも引用符の書き損じで JSON として読めない。
  const observed = '```json\n{\n  "verdict": "approve",\n  "comment": "ファイル変更なし（diff=""）、検証コマンド成功。"\n}\n```';
  assert.throws(() => parseReviewResult(observed), /Invalid review result/);
  assert.deepEqual(parseReviewResult(JSON.stringify({ verdict: "approve", comment: 'ファイル変更なし（diff=""）' })),
    { verdict: "approve", comment: 'ファイル変更なし（diff=""）' });
});

test("review prompt keeps the request, reply and artifact in fixed sections", () => {
  const prompt = buildReviewPrompt({ request: { title: "T", task: "Do {x}", accept: ["true"] }, reply: "", artifact: { patch_hash: "h" } });
  assert.ok(prompt.startsWith("Review a delegated task. Do not edit files."));
  assert.ok(prompt.includes('Original request:\n{"title":"T","task":"Do {x}","accept":["true"]}\n'));
  assert.ok(prompt.endsWith('Fixed artifact:\n{"patch_hash":"h"}'));
  assert.ok(!prompt.includes('"scope"'));
});

test("failed acceptance does not start a reviewer or retry automatically", async (t) => {
  const { intake, codex, claude, request } = fixture(t);
  intake.submit({ ...request, accept: ["exit 7"] });
  await until(() => intake.status(request.requestId).state === "running");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  const result = await intake.wait(request.requestId);
  assert.equal(result.state, "failed"); assert.equal(result.result?.acceptance.results[0].exitCode, 7);
  assert.equal(claude.starts.length, 0); assert.equal(codex.starts.length, 1);
});

const samples = JSON.parse(readFileSync(new URL("./samples/S16/input.json", import.meta.url), "utf8")) as { name: string; observeBefore: boolean; env: Record<string, string> }[];
const expected = JSON.parse(readFileSync(new URL("./samples/S16/expected.json", import.meta.url), "utf8"));
for (const sample of samples) test(`S16: ${sample.name}`, async (t) => {
  const { intake, ledger, codex, request, observe } = fixture(t);
  if (sample.observeBefore) observe();
  const submission = { ...request, ...readOrigin(sample.env) };
  intake.submit(submission); intake.submit(submission);
  await until(() => intake.status(request.requestId).state === "running");
  if (!sample.observeBefore) {
    const pending = ledger.readSince(0, 1000).findLast((f) => f.kind.startsWith("relation."));
    assert.equal(pending?.confidence, expected.beforeObservation.confidence);
    observe();
  }
  intake.reconcileOrigins();
  const before = ledger.readSince(0, 1000).length;
  observe(); intake.reconcileOrigins(); intake.submit(submission);
  assert.equal(ledger.readSince(0, 1000).length, before);
  const facts = ledger.readSince(0, 1000);
  const relations = projectRelations(facts);
  assert.equal(relations.length, 1); assert.equal(relations[0].confidence, expected.afterObservation.confidence);
  assert.equal(relations[0].from_id, JSON.stringify(["claude", expected.afterObservation.parentNativeId]));
  assert.equal(relations[0].type, expected.afterObservation.type);
  assert.equal(projectDelegations(facts).length, expected.delegations);
  assert.deepEqual(projectRelations([...facts].reverse()), relations);
  assert.deepEqual(projectDelegations([...facts].reverse()), projectDelegations(facts));
  assert.deepEqual(projectRelations(ledger.readSince(0, 1000)), relations);
  assert.equal(codex.starts.length, expected.implementerStarts);
});

test("socket commands dispatch submit, status, list and explicit retry", async (t) => {
  const { intake, codex, request } = fixture(t);
  const command = (name: string, payload: unknown) => intake.command({ type: "req", cmd_id: name, command: `intake.${name}`, payload: JSON.parse(JSON.stringify(payload)) });
  assert.equal((await command("submit", request) as { state: string }).state, "accepted");
  assert.equal((await command("status", { requestId: request.requestId }) as { state: string }).state, "accepted");
  assert.equal((await command("list", {}) as unknown[]).length, 1);
  await until(() => intake.status(request.requestId).state === "running");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 1 }); await intake.wait(request.requestId);
  assert.equal((await command("retry", { requestId: request.requestId }) as { attempt: number }).attempt, 2);
});

test("accepted request survives restart before dispatch and launches once", async (t) => {
  const { intake, ledger, request, codex, claude } = fixture(t);
  intake.submit(request);
  await intake.close();
  assert.equal(codex.starts.length, 0);
  const runtime = new RunnerRuntime(ledger, [codex, claude], () => {}, "shared");
  const recovered = new Intake(ledger, runtime, { cwd: request.cwd });
  await recovered.recover();
  assert.equal(recovered.submit(request).state, "accepted");
  await until(() => recovered.status(request.requestId).state === "running");
  assert.equal(codex.starts.length, 1);
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 1 });
  await recovered.wait(request.requestId);
  await recovered.close();
});

test("managed parentRun takes priority over origin", async (t) => {
  const { intake, ledger, request } = fixture(t);
  ledger.append({ source: "host-codex", source_event_id: "parent-conversation", source_ts: "2026-01-01T00:00:00Z",
    kind: "conversation.created", subject: "conversation:managed-parent", confidence: "confirmed",
    payload: { provider: "codex", native_id: "managed", origin: "managed", type: "interactive", history_format: "jsonl" } });
  ledger.append({ source: "host-codex", source_event_id: "parent-run", source_ts: "2026-01-01T00:00:01Z",
    kind: "run.created", subject: "run:parent-run", confidence: "confirmed", payload: { conversation_id: "managed-parent", generation: 1, state: "ended" } });
  intake.submit({ ...request, parentRun: "parent-run", origin: { provider: "claude", nativeId: "absent" } });
  await until(() => intake.status(request.requestId).state === "running");
  const relation = projectRelations(ledger.readSince(0, 1000))[0];
  assert.equal(relation.confidence, "confirmed");
  assert.equal(relation.from_id, JSON.stringify(["codex", "managed"]));
});

test("review denial and scope violation remain terminal until explicit retry", async (t) => {
  const { intake, request, codex, claude } = fixture(t);
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  emitReview(claude, "request_changes");
  assert.equal((await intake.wait(request.requestId)).state, "failed");
  intake.submit({ ...request, requestId: "scope", scope: ["allowed/**"] });
  await until(() => intake.status("scope").state === "running");
  writeFileSync(join(codex.starts[1].cwd, "file.txt"), "outside scope\n");
  codex.emit(codex.starts[1].runId, { type: "exit", exitCode: 0 });
  assert.deepEqual((await intake.wait("scope")).result?.acceptance.scopeViolations, ["file.txt"]);
  assert.equal(claude.starts.length, 1);
});

test("host turn completion closes the managed handle and proceeds to verification", async (t) => {
  const { intake, request, codex, claude } = fixture(t);
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  const runId = codex.starts[0].runId;
  codex.emit(runId, { type: "fact", fact: { source_event_id: "turn-completed", source_ts: new Date().toISOString(),
    kind: "run.state_changed", subject: `run:${runId}`, confidence: "confirmed", payload: { state: "idle", last_evidence: { status: "completed", turn_id: "turn" } } } });
  await until(() => claude.starts.length === 1);
  emitReview(claude);
  assert.equal((await intake.wait(request.requestId)).state, "done");
});

async function seedRunning(f: ReturnType<typeof fixture>) {
  const assignment = { ...defaultPolicy().roles.implement[0], reason: ["fixture"], policyVersion: "fixture" };
  f.ledger.append({ source: "intake", source_event_id: "seed-request", source_ts: "2026-01-01T00:00:00Z",
    kind: "delegation.created", subject: `delegation:${f.request.requestId}`, confidence: "confirmed",
    payload: JSON.parse(JSON.stringify({ request_id: f.request.requestId, role: f.request.role, title: f.request.title,
      state: "accepted", attempt: 1, request: f.request, request_hash: fingerprintRequest(f.request) })) });
  f.ledger.append({ source: "intake", source_event_id: "seed-assignment", source_ts: "2026-01-01T00:00:01Z",
    kind: "delegation.attempt_created", subject: `delegation:${f.request.requestId}`, confidence: "confirmed",
    payload: { attempt: 1, run_id: "implementation", assignment } });
  f.ledger.append({ source: "intake", source_event_id: "seed-assigned", source_ts: "2026-01-01T00:00:02Z",
    kind: "delegation.state_changed", subject: `delegation:${f.request.requestId}`, confidence: "confirmed",
    payload: { state: "assigned", attempt: 1 } });
  await f.runtime.supervisor.start("codex", { runId: "implementation", conversationId: "child", generation: 1,
    cwd: f.request.cwd!, model: { model: assignment.model }, input: { text: f.request.task } });
  f.ledger.append({ source: "intake", source_event_id: "seed-running", source_ts: new Date(Date.now() + 10).toISOString(),
    kind: "delegation.state_changed", subject: `delegation:${f.request.requestId}`, confidence: "confirmed", payload: { state: "running", attempt: 1 } });
}

test("recovery continues a retained child through acceptance and review without relaunch", async (t) => {
  const f = fixture(t);
  await seedRunning(f);
  await f.intake.recover();
  assert.equal(f.intake.submit(f.request).state, "running");
  f.codex.emit("implementation", { type: "exit", exitCode: 0 });
  await until(() => f.claude.starts.length === 1);
  emitReview(f.claude);
  assert.equal((await f.intake.wait(f.request.requestId)).state, "done");
  assert.equal(f.codex.starts.length, 1);
});

test("recovery marks a missing child interrupted and does not restart it", async (t) => {
  const f = fixture(t);
  await seedRunning(f);
  f.codex.emit("implementation", { type: "exit", exitCode: 1 });
  await f.runtime.supervisor.wait("implementation");
  await f.intake.recover();
  assert.equal(f.intake.status(f.request.requestId).state, "interrupted");
  assert.equal(f.intake.submit(f.request).state, "interrupted");
  assert.equal(f.codex.starts.length, 1);
});

test("interrupted turn is terminal even when its handle exits successfully", async (t) => {
  const { intake, request, codex, claude } = fixture(t);
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  const runId = codex.starts[0].runId;
  codex.emit(runId, { type: "fact", fact: { source_event_id: "interrupted-turn", source_ts: new Date().toISOString(),
    kind: "run.updated", subject: `run:${runId}`, confidence: "confirmed", payload: { last_evidence: { status: "interrupted" } } } });
  codex.emit(runId, { type: "exit", exitCode: 0 });
  assert.equal((await intake.wait(request.requestId)).state, "interrupted");
  assert.equal(claude.starts.length, 0);
  assert.equal(codex.starts.length, 1);
});

test("runner socket serves the four intake commands", async (t) => {
  const f = fixture(t);
  const path = join(f.request.cwd!, "runner.sock");
  let server: Awaited<ReturnType<typeof serveIntakeRunner>>;
  try { server = await serveIntakeRunner(f.ledger, path, { hosts: [f.codex, f.claude], isolation: "shared" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix socket listen is blocked by the sandbox"); return; }
    throw error;
  }
  const client = createConnection(path);
  client.setEncoding("utf8");
  let buffer = "";
  const pending = new Map<string, (result: { ok: boolean; result: unknown }) => void>();
  client.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.type === "res") { pending.get(message.cmd_id)?.(message); pending.delete(message.cmd_id); }
    }
  });
  await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(JSON.stringify({ type: "hello", version: 1, role: "cli" }) + "\n");
  async function command(name: string, payload: unknown) {
    const cmdId = `socket-${name}`;
    const response = new Promise<{ ok: boolean; result: unknown }>((resolve) => pending.set(cmdId, resolve));
    client.write(JSON.stringify({ type: "req", cmd_id: cmdId, command: `intake.${name}`, payload }) + "\n");
    const reply = await response; assert.equal(reply.ok, true); return reply.result;
  }
  try {
    assert.equal((await command("submit", f.request) as { state: string }).state, "accepted");
    assert.equal((await command("list", {}) as unknown[]).length, 1);
    assert.equal((await command("status", { requestId: f.request.requestId }) as { requestId: string }).requestId, f.request.requestId);
    await until(() => server.intake.status(f.request.requestId).state === "running");
    f.codex.emit(f.codex.starts[0].runId, { type: "exit", exitCode: 1 });
    await server.intake.wait(f.request.requestId);
    assert.equal((await command("retry", { requestId: f.request.requestId }) as { attempt: number }).attempt, 2);
  } finally { client.destroy(); await server.close(); }
});

test("resend completes acceptance after a failure between request and acceptance writes", async (t) => {
  const { intake, ledger, request, codex } = fixture(t);
  const append = ledger.append;
  let calls = 0;
  ledger.append = (fact) => {
    calls += 1;
    if (calls === 2) throw new Error("acceptance write failed");
    return append(fact);
  };
  assert.throws(() => intake.submit(request), /acceptance write failed/);
  ledger.append = append;
  assert.equal(codex.starts.length, 0);
  assert.equal(intake.submit(request).state, "accepted");
  await until(() => intake.status(request.requestId).state === "running");
  assert.equal(codex.starts.length, 1);
  assert.equal(projectDelegations(ledger.readSince(0, 1000)).length, 1);
});

for (const output of [
  'I checked the artifact.\n```json\n{"verdict":"approve","comment":"Checked"}\n```\nReview complete.',
  'Earlier result: {"verdict":"request_changes","comment":"Draft"}\nFinal result: {"verdict":"approve","comment":"Checked"}',
  'Summary {not JSON}.\n{"verdict":"approve","comment":"Checked { braces } and \\"quotes\\""}',
]) test("review accepts JSON surrounded by prose or fences: " + output.slice(0, 25), async (t) => {
  const { intake, request, codex, claude } = fixture(t);
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  emitReview(claude, "approve", output);
  const status = await intake.wait(request.requestId);
  assert.equal(status.state, "done");
  assert.equal(status.result?.review?.verdict, "approve");
});

test("review parser rejects missing, malformed and invalid final results", () => {
  for (const output of [
    "No review result", '```json\n{"verdict":"approve"\n```',
    '{"verdict":"approve","comment":42}', '{"verdict":"unknown","comment":"Checked"}',
    '{"verdict":"approve","comment":"Draft"}\n{"verdict":"invalid","comment":"Final"}',
  ]) assert.throws(() => parseReviewResult(output), /Invalid review result/);
  assert.deepEqual(parseReviewResult('```json\n{"verdict":"request_changes","comment":"Fix it"}\n```'),
    { verdict: "request_changes", comment: "Fix it" });
});

test("intake reads bounded batches once and only new facts while a host is running", async (t) => {
  const { intake, ledger, request, codex, claude, observe } = fixture(t);
  for (let index = 0; index < 2500; index += 1) ledger.append({
    source: "transcript-claude", source_event_id: `history:${index}`, source_ts: "2026-01-01T00:00:00Z",
    kind: "message.created", subject: `message:history:${index}`, confidence: "confirmed",
    payload: { provider: "claude", native_id: `history:${index}`, role: "assistant", version: 1, body_state: "stored", body: "History" },
  });
  const readSince = ledger.readSince;
  const reads: { seq: number; limit: number; count: number }[] = [];
  ledger.readSince = (seq, limit) => {
    const facts = readSince(seq, limit);
    reads.push({ seq, limit, count: facts.length });
    return facts;
  };
  t.after(() => { ledger.readSince = readSince; });
  intake.submit({ ...request, origin: { provider: "claude", nativeId: "terminal-claude" } });
  assert.ok(reads.every((read) => read.limit <= 1000));
  assert.equal(reads.filter((read) => read.seq === 0).length, 1);
  await until(() => intake.status(request.requestId).state === "running");
  intake.reconcileOrigins();
  intake.list();
  reads.length = 0;
  await new Promise<void>((resolve) => setTimeout(resolve, 1100));
  assert.ok(reads.length <= 3, `Idle host caused ${reads.length} ledger reads`);
  assert.ok(reads.every((read) => read.seq > 2500 && read.count === 0));
  for (let index = 0; index < 20; index += 1) {
    intake.status(request.requestId); intake.list(); intake.reconcileOrigins();
  }
  assert.ok(reads.every((read) => read.seq > 2500 && read.count === 0));
  observe(); intake.reconcileOrigins();
  assert.equal(projectRelations(readSince(0, 10000))[0].confidence, "confirmed");
  ledger.readSince = readSince;
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  emitReview(claude);
  assert.equal((await intake.wait(request.requestId)).state, "done");
});

test("a retried delegation links acceptance and review to the next task artifact version", async (t) => {
  const { intake, ledger, codex, claude, request } = fixture(t);
  intake.submit(request);
  await until(() => intake.status(request.requestId).state === "running");
  writeFileSync(join(codex.starts[0].cwd, "file.txt"), "first change\n");
  codex.emit(codex.starts[0].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 1);
  emitReview(claude, "request_changes");
  assert.equal((await intake.wait(request.requestId)).state, "failed");
  const first = projectEntityRecords<{ version: number }>(ledger.readSince(0, 1000), "artifact")[0];
  assert.equal(first.version, 1);
  intake.retry(request.requestId);
  await until(() => codex.starts.length === 2);
  writeFileSync(join(codex.starts[1].cwd, "file.txt"), "corrected change\n");
  codex.emit(codex.starts[1].runId, { type: "exit", exitCode: 0 });
  await until(() => claude.starts.length === 2);
  emitReview(claude);
  assert.equal((await intake.wait(request.requestId)).state, "done");
  const facts = ledger.readSince(0, 1000);
  assert.equal(facts.filter((fact) => fact.kind === "artifact.version_created").length, 2);
  const second = projectEntityRecords<{ version: number; previous_artifact_id: string; verification: { passed: boolean } }>(facts, "artifact")
    .find((artifact) => artifact.version === 2)!;
  assert.equal(second.previous_artifact_id, first.id);
  assert.equal(second.verification!.passed, true);
  const attempt = projectDelegations(facts)[0].attempts[1];
  assert.equal((attempt.review as { artifact_id: string }).artifact_id, second.id);
});
