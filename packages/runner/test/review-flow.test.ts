import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { loadPolicy } from "../../core/src/assign/policy.ts";
import type { FactInput, JsonValue } from "../../core/src/ledger/facts.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectArtifacts } from "../../core/src/ledger/projections/artifacts.ts";
import { canMergeArtifact, projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import { projectFindings } from "../../core/src/ledger/projections/findings.ts";
import { projectRelations } from "../../core/src/ledger/projections/relations.ts";
import { finalizeArtifacts } from "../src/artifacts/index.ts";
import { FakeHost, type ResumeRequest } from "../src/host/contract.ts";
import { Intake } from "../src/intake/index.ts";
import { RunnerRuntime } from "../src/runtime.ts";
import { ReviewFlow } from "../src/review/index.ts";

class ResumableHost extends FakeHost {
  override async resume(request: ResumeRequest) { return { ...await this.start(request), nativeId: request.nativeId }; }
}
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, "Timed out"); await delay(10); }
}
async function createFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "review-flow-"));
  const directory = join(root, "repo");
  mkdirSync(directory);
  const blobs = join(root, "agent-graph", "blobs");
  const oldState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(directory, "code.txt"), Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  git("add", "code.txt"); git("commit", "-m", "base");
  const ledger = openLedger(join(root, "ledger.db"), { storageScope: "full_diff" });
  const codex = new ResumableHost("codex"); const claude = new ResumableHost("claude");
  const runtime = new RunnerRuntime(ledger, [codex, claude], () => {});
  const intake = new Intake(ledger, runtime, { reviewBlobDirectory: blobs,
    decision: { policy: loadPolicy({ path: join(directory, "missing-policy") }), quota: () => undefined, performance: () => undefined } });
  t.after(async () => { await intake.close(); ledger.close();
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    rmSync(root, { recursive: true, force: true }); });
  await runtime.command({ type: "req", cmd_id: "start", command: "start", payload: { provider: "codex", runId: "implementation",
    conversationId: "conversation", cwd: directory, input: { text: "Fix code" }, model: { model: "fake" } } });
  ledger.append({ source: "intake", source_event_id: "delegation", source_ts: new Date().toISOString(), kind: "delegation.created",
    subject: "delegation:task", confidence: "confirmed", payload: { request_id: "task", role: "implement", title: "Fix code", task: "Fix code",
      accept: ["test -f code.txt"], scope: ["code.txt"], attempt: 1, state: "done", run_id: "implementation", result: { output: "Implemented" } } } as FactInput);
  function edit(second = false, contextChanged = false) {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
    lines[3] = "change A"; lines[19] = second ? "fixed B" : "change B";
    if (contextChanged) lines[18] = "changed context";
    writeFileSync(join(directory, "code.txt"), lines.join("\n") + "\n");
  }
  function capture(runId = "implementation") {
    return finalizeArtifacts(ledger, { runId, provider: "codex", sourceEventId: randomUUID(), sourceTs: new Date().toISOString() }, { blobDirectory: blobs })!;
  }
  const cmd = (command: string, payload: JsonValue) => intake.command({ type: "req", cmd_id: randomUUID(), command, payload }) as Promise<any>;
  edit(); const first = capture();
  return { directory, ledger, intake, runtime, codex, claude, first, edit, capture, cmd };
}

test("findings return to original conversation, remap uniquely, require checking when context changes, and invalidate approval", async (t) => {
  const f = await createFixture(t);
  const a = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Check A", severity: "high" });
  const b = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 20, body: "Fix B", severity: "high" });
  const approval = await f.cmd("review.approve", { artifactId: f.first.id });
  assert.equal(canMergeArtifact(f.ledger.readSince(0, 1000), f.first.id), true);
  const sent = await f.cmd("review.send", { artifactId: f.first.id, findingIds: [a.id, b.id] });
  assert.equal(sent.runId, "implementation");
  assert.equal(f.codex.inputs.length, 1);
  assert.ok(f.codex.inputs[0].input.text.includes("Fix B"));
  assert.ok(projectFindings(f.ledger.readSince(0, 1000)).every((entry) => entry.state === "sent"));
  f.edit(true, true); f.codex.emit("implementation", { type: "exit", exitCode: 0 });
  await f.runtime.supervisor.wait("implementation");
  await f.intake.review.reconcile();
  const artifacts = projectArtifacts(f.ledger.readSince(0, 1000));
  const next = artifacts.at(-1)!;
  assert.notEqual(next.id, f.first.id);
  assert.equal((next.verification as { passed: boolean }).passed, true);
  const findings = projectFindings(f.ledger.readSince(0, 1000));
  assert.equal(findings.find((entry) => entry.id === a.id)!.artifact_id, next.id);
  assert.equal(findings.find((entry) => entry.id === a.id)!.state, "needs_check");
  assert.equal(findings.find((entry) => entry.id === b.id)!.state, "needs_check");
  assert.equal(projectApprovals(f.ledger.readSince(0, 1000)).find((entry) => entry.id === approval.id)!.state, "stale");
  assert.equal(canMergeArtifact(f.ledger.readSince(0, 1000), next.id), false);
  await f.cmd("review.finding_state", { findingId: a.id, state: "fixed" });
  await f.cmd("review.finding_state", { findingId: a.id, state: "verified" });
  assert.equal(projectFindings(f.ledger.readSince(0, 1000)).find((entry) => entry.id === a.id)!.state, "verified");
  await f.cmd("review.revoke", { approvalId: approval.id });
  assert.equal(projectApprovals(f.ledger.readSince(0, 1000)).find((entry) => entry.id === approval.id)!.state, "revoked");
});

test("closed execution is resumed once before sending findings and successor is reverified", async (t) => {
  const f = await createFixture(t);
  const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 20, body: "Fix B", severity: "high" });
  f.codex.emit("implementation", { type: "exit", exitCode: 0 }); await f.runtime.supervisor.wait("implementation");
  const sent = await f.cmd("review.send", { artifactId: f.first.id, findingIds: [finding.id] });
  assert.notEqual(sent.runId, "implementation");
  assert.equal(f.codex.starts.at(-1)!.conversationId, "conversation");
  assert.equal(f.codex.starts.at(-1)!.generation, 2);
  assert.ok(f.codex.starts.at(-1)!.input.text.includes("Fix B"));
  assert.equal(f.codex.inputs.length, 0);
  await assert.rejects(f.cmd("review.send", { artifactId: f.first.id, findingIds: [finding.id] }));
  f.edit(true); f.codex.emit(sent.runId, { type: "exit", exitCode: 0 }); await f.runtime.supervisor.wait(sent.runId);
  await f.intake.review.reconcile();
  const next = projectArtifacts(f.ledger.readSince(0, 1000)).find((entry) => entry.run_id === sent.runId)!;
  assert.equal(next.previous_artifact_id, f.first.id);
  assert.equal((next.verification as { passed: boolean }).passed, true);
  assert.equal(projectFindings(f.ledger.readSince(0, 1000)).find((entry) => entry.id === finding.id)!.state, "fixed");
});

test("partial return preserves unsent and resolved states on a new version and unsent findings remain sendable", async (t) => {
  const f = await createFixture(t);
  const a = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Check A", severity: "high" });
  const b = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 20, body: "Check B", severity: "high" });
  const fixed = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Fixed", severity: "low" });
  const verified = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 20, body: "Verified", severity: "low" });
  await f.cmd("review.finding_state", { findingId: fixed.id, state: "fixed" });
  await f.cmd("review.finding_state", { findingId: verified.id, state: "fixed" });
  await f.cmd("review.finding_state", { findingId: verified.id, state: "verified" });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [a.id] });
  assert.ok(!f.codex.inputs[0].input.text.includes("Check B"));
  f.edit(true);
  f.codex.emit("implementation", { type: "state", state: "idle" });
  await waitUntil(() => projectArtifacts(f.ledger.readSince(0, 1000)).length === 2);
  await f.intake.review.reconcile();
  const next = projectArtifacts(f.ledger.readSince(0, 1000)).at(-1)!;
  assert.equal((next.verification as { passed: boolean }).passed, true);
  const findings = projectFindings(f.ledger.readSince(0, 1000));
  for (const [id, state] of [[a.id, "needs_check"], [b.id, "open"], [fixed.id, "fixed"], [verified.id, "verified"]]) {
    const finding = findings.find((entry) => entry.id === id)!;
    assert.equal(finding.artifact_id, next.id);
    assert.equal(finding.state, state);
    if (id !== a.id) assert.ok(!("return_run_id" in finding));
  }
  await f.cmd("review.send", { artifactId: next.id, findingIds: [b.id] });
  assert.equal(f.codex.inputs.length, 2);
  assert.ok(f.codex.inputs[1].input.text.includes("Check B"));
  assert.equal(projectFindings(f.ledger.readSince(0, 1000)).find((entry) => entry.id === b.id)!.state, "sent");
});

test("context hashes exclude the selected range and remap edited lines after a line shift on either side", async () => {
  const { collectContexts, readFindingLines } = await import("../src/review/contexts.ts");
  const { remapFinding } = await import("../../core/src/ledger/projections/findings.ts");
  const patch = (start: number, selected: string, before = "before", after = "after") =>
    `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -${start},6 +${start},6 @@\n first\n ${before}\n ${selected}\n ${after}\n last\n`;
  for (const side of ["old", "new"] as const) {
    for (const width of [1, 2]) {
      const original = collectContexts(patch(1, "target\n target end"), width)
        .find((entry) => entry.side === side && entry.start_line === 3)!;
      const finding = { ...original, artifact_id: "old", version: 1, state: "sent" as const };
      const edited = collectContexts(patch(10, width === 1 ? "fixed\n target end" : "fixed\n fixed end"), width);
      const mapped = remapFinding(finding, { artifact_id: "new", version: 2 }, edited);
      assert.equal(mapped.start_line, 12);
      assert.equal(mapped.end_line, 12 + width - 1);
      assert.equal(mapped.state, "sent");
      assert.equal(mapped.context_hash, original.context_hash);
      assert.deepEqual(readFindingLines(patch(1, "target\n target end"), original), width === 1 ? ["target"] : ["target", "target end"]);
      assert.deepEqual(readFindingLines(patch(10, width === 1 ? "fixed\n target end" : "fixed\n fixed end"), mapped),
        width === 1 ? ["fixed"] : ["fixed", "fixed end"]);
      for (const [before, after] of [["different", "after"], ["before", "different"]]) {
        const changed = collectContexts(patch(10, "fixed\n fixed end", before, after), width);
        assert.equal(remapFinding(finding, { artifact_id: "new", version: 2 }, changed).state, "needs_check");
      }
    }
  }
});

test("reverification compares the whole mapped range and a different-family reviewer verifies automatic fixes", async (t) => {
  const f = await createFixture(t);
  const unchanged = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Check A", severity: "high" });
  const changed = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 19, endLine: 20, body: "Fix B range", severity: "high" });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [unchanged.id, changed.id] });
  f.edit(true);
  f.codex.emit("implementation", { type: "exit", exitCode: 0 });
  await f.runtime.supervisor.wait("implementation");
  await f.intake.review.reconcile();
  const next = projectArtifacts(f.ledger.readSince(0, 1000)).at(-1)!;
  const findings = projectFindings(f.ledger.readSince(0, 1000));
  assert.equal(findings.find((entry) => entry.id === unchanged.id)!.state, "needs_check");
  assert.equal(findings.find((entry) => entry.id === changed.id)!.state, "fixed");
  assert.ok(findings.every((entry) => entry.artifact_id === next.id && entry.state !== "sent"));
  f.ledger.append({ source: "ui", source_event_id: "unrelated-update", source_ts: new Date().toISOString(),
    kind: "run.updated", subject: "run:implementation", confidence: "confirmed", payload: {} });
  const before = f.ledger.readSince(0, 1000).length;
  await f.intake.review.reconcile();
  assert.equal(f.ledger.readSince(0, 1000).length, before);
  const review = f.cmd("review.start", { artifactId: next.id });
  await waitUntil(() => f.claude.starts.length === 1);
  const request = f.claude.starts[0];
  await waitUntil(() => f.ledger.readSince(0, 1000).some((fact) => fact.subject === `relation:${request.runId}`));
  f.claude.emit(request.runId, { type: "fact", fact: { source_event_id: "automatic-fix-review", source_ts: new Date().toISOString(),
    kind: "message.created", subject: "message:automatic-fix-review", confidence: "confirmed", payload: { provider: "claude", native_id: "automatic-fix-review",
      version: 1, role: "assistant", phase: "final_answer", body_state: "stored", body: '{"verdict":"approve","comment":"Fixed"}' } } });
  f.claude.emit(request.runId, { type: "fact", fact: { source_event_id: "automatic-fix-membership", source_ts: new Date().toISOString(),
    kind: "message_membership.created", subject: "message_membership:automatic-fix-review", confidence: "confirmed",
    payload: { conversation_id: request.conversationId, message_id: "automatic-fix-review", active: true } } });
  f.claude.emit(request.runId, { type: "exit", exitCode: 0 });
  const result = await review;
  assert.equal(result.request.reviewer.family, "anthropic");
  assert.equal(result.patch_hash, next.patch_hash);
  const reviewed = projectFindings(f.ledger.readSince(0, 1000));
  assert.equal(reviewed.find((entry) => entry.id === changed.id)!.state, "verified");
  assert.equal(reviewed.find((entry) => entry.id === unchanged.id)!.state, "needs_check");
});

test("added lines resembling diff headers retain their file and content", async () => {
  const { collectContexts, readFindingLines } = await import("../src/review/contexts.ts");
  const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n before\n-old\n+++ literal\n after\n';
  const location = { file: "a.txt", side: "new" as const, start_line: 2, end_line: 2 };
  assert.ok(collectContexts(patch).some((entry) => entry.file === "a.txt" && entry.side === "new" && entry.start_line === 2));
  assert.deepEqual(readFindingLines(patch, location), ["++ literal"]);
  assert.equal(readFindingLines(patch, { ...location, start_line: 100, end_line: 100 }), undefined);
});

test("shifted single and multiple lines are compared on the mapped side of the fixed patches", async (t) => {
  const f = await createFixture(t);
  const findings: { id: string; side: string; width: number }[] = [];
  for (const side of ["old", "new"]) {
    for (const width of [1, 2]) {
      const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side,
        startLine: 21 - width, endLine: 20, body: "Check range", severity: "high" });
      findings.push({ id: finding.id, side, width });
    }
  }
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: findings.map((finding) => finding.id) });
  f.edit(true);
  const file = join(f.directory, "code.txt");
  writeFileSync(file, "inserted first\ninserted second\n" + readFileSync(file, "utf8"));
  f.codex.emit("implementation", { type: "exit", exitCode: 0 });
  await f.runtime.supervisor.wait("implementation");
  await f.intake.review.reconcile();
  const next = projectArtifacts(f.ledger.readSince(0, 1000)).at(-1)!;
  const mapped = projectFindings(f.ledger.readSince(0, 1000));
  for (const finding of findings) {
    const result = mapped.find((entry) => entry.id === finding.id)!;
    assert.equal(result.artifact_id, next.id);
    assert.equal(result.state, finding.side === "new" ? "fixed" : "needs_check");
    assert.equal(result.start_line, (finding.side === "new" ? 23 : 21) - finding.width);
    assert.equal(result.end_line, finding.side === "new" ? 22 : 20);
  }
});

test("reviewer has a different family, uses host schema and records result on fixed version", async (t) => {
  const f = await createFixture(t);
  const sent = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Unfixed", severity: "high" });
  const fixed = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 20, body: "Fixed", severity: "low" });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [sent.id] });
  await f.cmd("review.finding_state", { findingId: fixed.id, state: "fixed" });
  const review = f.cmd("review.start", { artifactId: f.first.id });
  await waitUntil(() => f.claude.starts.length === 1);
  assert.equal(f.codex.starts.length, 1);
  const request = f.claude.starts[0];
  assert.ok(request.outputSchema);
  await waitUntil(() => f.ledger.readSince(0, 1000).some((fact) => fact.subject === `relation:${request.runId}`));
  const relation = projectRelations(f.ledger.readSince(0, 1000))
    .find((entry) => entry.from_id === JSON.stringify(["claude", request.runId]))!;
  assert.equal(relation.type, "review_of");
  assert.deepEqual(relation.evidence, { artifact_id: f.first.id, patch_hash: f.first.patch_hash });
  assert.equal(relation.from_id, JSON.stringify(["claude", request.runId]));
  assert.equal(relation.to_id, '["codex","implementation"]');
  for (const value of [f.first.patch_hash, "Original request", "Implemented"]) assert.ok(request.input.text.includes(value));
  f.claude.emit(request.runId, { type: "fact", fact: { source_event_id: "review-message", source_ts: new Date().toISOString(),
    kind: "message.created", subject: "message:review", confidence: "confirmed", payload: { provider: "claude", native_id: "review",
      version: 1, role: "assistant", phase: "final_answer", body_state: "stored", body: '{"verdict":"approve","comment":"OK"}' } } });
  f.claude.emit(request.runId, { type: "fact", fact: { source_event_id: "review-membership", source_ts: new Date().toISOString(),
    kind: "message_membership.created", subject: "message_membership:review", confidence: "confirmed",
    payload: { conversation_id: request.conversationId, message_id: "review", active: true } } });
  f.claude.emit(request.runId, { type: "exit", exitCode: 0 });
  const result = await review;
  assert.equal(result.patch_hash, f.first.patch_hash);
  assert.equal(result.request.reviewer.family, "anthropic");
  const findings = projectFindings(f.ledger.readSince(0, 1000));
  assert.equal(findings.find((entry) => entry.id === sent.id)!.state, "sent");
  assert.equal(findings.find((entry) => entry.id === fixed.id)!.state, "verified");
  f.edit(true); f.capture();
  assert.equal(projectApprovals(f.ledger.readSince(0, 1000)).find((entry) => entry.id === result.id)!.state, "stale");
});

test("review writes support 200000 facts and retain monotonic timestamps across both readers", async (t) => {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  const factCount = 200_000;
  const future = "2040-01-01T00:00:00.000Z";
  ledger.append({ source: "ui", source_event_id: "approval", source_ts: future, kind: "approval.created",
    subject: "approval:large", confidence: "confirmed", payload: { run_id: "padding", request_id: "approval", artifact_id: "artifact", patch_hash: "hash", state: "approved" } });
  for (let index = 1; index < factCount; index++) {
    ledger.append({ source: "ui", source_event_id: `padding:${index}`, source_ts: "2026-01-01T00:00:00Z",
      kind: "run.updated", subject: "run:padding", confidence: "confirmed", payload: {} });
  }
  const runtime = new RunnerRuntime(ledger, [], () => {});
  const decision = { policy: loadPolicy(), quota: () => undefined, performance: () => undefined };
  const standalone = new ReviewFlow(ledger, runtime, decision);
  await standalone.command({ type: "req", cmd_id: "large-revoke", command: "review.revoke", payload: { approvalId: "large" } });
  const facts = ledger.readSince(0, factCount + 10);
  assert.equal(projectApprovals(facts)[0].state, "revoked");
  assert.ok(Date.parse(facts.at(-2)!.source_ts) > Date.parse(future));
  assert.ok(Date.parse(facts.at(-1)!.source_ts) > Date.parse(facts.at(-2)!.source_ts));
  const shared = new ReviewFlow(ledger, runtime, decision, undefined, undefined, undefined,
    () => ledger.readSince(0, factCount + 10));
  await shared.command({ type: "req", cmd_id: "large-revoke-shared", command: "review.revoke", payload: { approvalId: "large" } });
  assert.ok(Date.parse(ledger.readSince(facts.at(-1)!.seq, 10)[0].source_ts) > Date.parse(facts.at(-1)!.source_ts));
});

test("unchanged ledger skips projections and transient reconciliation failure preserves sent findings", async (t) => {
  const f = await createFixture(t);
  const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Check A", severity: "high" });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [finding.id] });
  let projections = 0;
  const flow = new ReviewFlow(f.ledger, f.runtime, { policy: loadPolicy(), quota: () => undefined, performance: () => undefined },
    undefined, undefined, undefined, () => new Proxy(f.ledger.readSince(0, 1000), {
      get(target, property, receiver) {
        if (property === "map") projections++;
        return Reflect.get(target, property, receiver);
      },
    }));
  await flow.reconcile();
  const count = projections;
  await flow.reconcile();
  assert.equal(projections, count);
  f.edit(true); f.capture();
  const isOpen = f.runtime.supervisor.isOpen.bind(f.runtime.supervisor);
  f.runtime.supervisor.isOpen = () => { throw new Error("Temporary host failure"); };
  await assert.rejects(flow.reconcile(), /Temporary host failure/);
  f.runtime.supervisor.isOpen = isOpen;
  assert.equal(projectFindings(f.ledger.readSince(0, 1000))[0].state, "sent");
  f.codex.emit("implementation", { type: "exit", exitCode: 0 });
  await f.runtime.supervisor.wait("implementation");
  await flow.reconcile();
  assert.equal((projectArtifacts(f.ledger.readSince(0, 1000)).at(-1)!.verification as { passed: boolean }).passed, true);
});

test("invalid positions and foreign findings are rejected before sending", async (t) => {
  const f = await createFixture(t);
  await assert.rejects(f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 900, body: "Bad", severity: "high" }));
  await assert.rejects(f.cmd("review.send", { artifactId: f.first.id, findingIds: ["missing"] }));
  assert.equal(f.codex.inputs.length, 0);
});

test("command receipts prevent duplicate delivery after intake recreation and reject conflicting cmd_id", async (t) => {
  const f = await createFixture(t);
  const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Fix A", severity: "high" });
  const request = { type: "req" as const, cmd_id: "stable-send", command: "review.send", payload: { artifactId: f.first.id, findingIds: [finding.id] } };
  const result = await f.intake.command(request);
  const { ReviewFlow } = await import("../src/review/index.ts");
  const restarted = new ReviewFlow(f.ledger, f.runtime, { policy: loadPolicy(), quota: () => undefined, performance: () => undefined });
  assert.deepEqual(await restarted.command(request), result);
  assert.equal(f.codex.inputs.length, 1);
  await assert.rejects(restarted.command({ ...request, payload: { artifactId: f.first.id, findingIds: ["other"] } }), /Conflicting/);
});

test("failed acceptance on new patch never verifies findings or preserves old merge permission", async (t) => {
  const f = await createFixture(t);
  const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Fix A", severity: "high" });
  const approval = await f.cmd("review.approve", { artifactId: f.first.id });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [finding.id] });
  f.ledger.append({ source: "intake", source_event_id: "failed-acceptance", source_ts: new Date(Date.now() + 1000).toISOString(),
    kind: "delegation.updated", subject: "delegation:task", confidence: "confirmed", payload: { accept: ["exit 1"] } });
  f.edit(true); f.codex.emit("implementation", { type: "exit", exitCode: 0 }); await f.runtime.supervisor.wait("implementation");
  await f.intake.review.reconcile();
  const artifacts = projectArtifacts(f.ledger.readSince(0, 1000));
  assert.equal((artifacts.at(-1)!.verification as { passed: boolean }).passed, false);
  assert.notEqual(projectFindings(f.ledger.readSince(0, 1000))[0].state, "verified");
  assert.equal(projectApprovals(f.ledger.readSince(0, 1000)).find((entry) => entry.id === approval.id)!.state, "stale");
});

test("S14 runner correction and operation target agree with corrected screen relation", async (t) => {
  const f = await createFixture(t);
  const { readFileSync } = await import("node:fs");
  const sample = JSON.parse(readFileSync(new URL("../../core/test/samples/S14/input.json", import.meta.url), "utf8")) as FactInput[];
  for (const fact of sample.slice(0, -1)) f.ledger.append(fact);
  const original = f.ledger.readSince(0, 1000).find((fact) => fact.subject === "relation:merged")!;
  const relations = await f.cmd("review.correct_relation", { factId: original.fact_id, fromId: "parent", toId: "correct" });
  const target = await f.cmd("review.relation_target", { relationId: "merged" });
  assert.equal(relations.find((entry: { to_id: string }) => entry.to_id === target.conversationId).to_id, '["codex","correct"]');
  assert.equal(target.runId, "correct");
  f.intake.reconcileOrigins();
  assert.equal((await f.cmd("review.relation_target", { relationId: "merged" })).runId, "correct");
  const retained = f.ledger.readSince(0, 1000).find((fact) => fact.fact_id === original.fact_id)!;
  assert.ok(retained.kind === "relation.created");
  assert.equal(retained.payload!.to_id, "wrong");
});

test("ambiguous repeated context is left for checking rather than guessed", async (t) => {
  const { collectContexts } = await import("../src/review/contexts.ts");
  const { remapFinding } = await import("../../core/src/ledger/projections/findings.ts");
  const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n same\n-old\n+new\n same\n@@ -10,3 +10,3 @@\n same\n-old\n+new\n same\n";
  const contexts = collectContexts(patch);
  const context = contexts.find((entry) => entry.side === "new" && entry.start_line === 2)!;
  const finding = { ...context, artifact_id: "old", version: 1, state: "sent" as const };
  assert.equal(remapFinding(finding, { artifact_id: "new", version: 2 }, contexts).state, "needs_check");
});

test("completed turn is reverified while the original host remains open", async (t) => {
  const f = await createFixture(t);
  const finding = await f.cmd("review.add_finding", { artifactId: f.first.id, file: "code.txt", side: "new", startLine: 4, body: "Check A", severity: "high" });
  await f.cmd("review.send", { artifactId: f.first.id, findingIds: [finding.id] });
  f.edit(true);
  f.codex.emit("implementation", { type: "state", state: "idle" });
  await waitUntil(() => projectArtifacts(f.ledger.readSince(0, 1000)).length === 2);
  await f.intake.review.reconcile();
  assert.equal(f.runtime.supervisor.isOpen("implementation"), true);
  assert.equal((projectArtifacts(f.ledger.readSince(0, 1000)).at(-1)!.verification as { passed: boolean }).passed, true);
});
