import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicy } from "../../core/src/assign/policy.ts";
import type { FactInput } from "../../core/src/ledger/facts.ts";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectConversations } from "../../core/src/ledger/projections/conversations.ts";
import { FakeHost, type StartRequest } from "../src/host/contract.ts";
import { RunnerRuntime } from "../src/runtime.ts";
import { ReviewFlow } from "../src/review/index.ts";

class FailingReviewer extends FakeHost {
  override async start(_request: StartRequest): Promise<never> { throw new Error("Review launch failed"); }
}

class CompletingReviewer extends FakeHost {
  override async start(request: StartRequest) {
    const handle = await super.start(request);
    const stamp = { source_ts: new Date().toISOString(), confidence: "confirmed" as const };
    this.emit(request.runId, { type: "fact", fact: { ...stamp, kind: "message.created", subject: "message:reply", source_event_id: "reply",
      payload: { provider: "claude", native_id: "reply", version: 1, role: "assistant", phase: "final_answer",
        body: JSON.stringify({ verdict: "approve", comment: "Reviewed" }), body_state: "stored" } } });
    this.emit(request.runId, { type: "fact", fact: { ...stamp, kind: "message_membership.created", subject: "message_membership:reply", source_event_id: "membership",
      payload: { conversation_id: request.conversationId, message_id: "reply", active: true } } });
    this.emit(request.runId, { type: "exit", exitCode: 0 });
    return handle;
  }
}

for (const fail of [true, false]) test(`review launch preserves task membership and relation when the host ${fail ? "fails" : "completes"}`, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "review-binding-"));
  const ledger = openLedger(join(directory, "ledger.db"), { storageScope: "full_diff" });
  const runtime = new RunnerRuntime(ledger, [fail ? new FailingReviewer("claude") : new CompletingReviewer("claude")], () => {});
  const review = new ReviewFlow(ledger, runtime, { policy: loadPolicy({ path: join(directory, "missing") }), quota: () => undefined, performance: () => undefined });
  t.after(async () => { await review.close(); ledger.close(); rmSync(directory, { recursive: true }); });
  execFileSync("git", ["init", "-b", "main", directory]);
  execFileSync("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base"]);
  const append = (kind: string, subject: string, payload: unknown) => ledger.append({ source: "ui", source_event_id: subject,
    source_ts: "2026-10-07T00:00:00.000Z", kind, subject, payload, confidence: "confirmed" } as FactInput);
  append("task.created", "task:original", { name: "Fix code", purpose: "Fix code", project: "/repo", state: "done" });
  append("conversation.created", "conversation:original", { provider: "codex", native_id: "implementation", origin: "managed", type: "interactive", history_format: "jsonl", task_id: "original" });
  append("run.created", "run:original", { conversation_id: "original", generation: 1, state: "ended", cwd: directory });
  append("delegation.created", "delegation:original", { request_id: "original", role: "implement", title: "Original request", task: "Fix code", accept: [], attempt: 1, state: "done", run_id: "original" });
  append("artifact.version_created", "artifact:original", { run_id: "original", version: 1, repository_id: "/repo", worktree_id: "tree", base_sha: "base", head_sha: "head", patch_hash: "hash", untracked: [], diff: "" });
  const command = review.command({ type: "req", cmd_id: "review", command: "review.start", payload: { artifactId: "original" } });
  if (fail) await assert.rejects(command, /Review launch failed/);
  else {
    const result = await command as { state: string; review_result_seq: number };
    assert.equal(result.state, "approved");
    const receipt = ledger.readSince(result.review_result_seq - 1, 1)[0];
    assert.equal(receipt.kind, "artifact.updated");
    assert.equal((receipt.payload as unknown as { review_command: { id: string } }).review_command.id, "review");
    assert.deepEqual(await review.command({ type: "req", cmd_id: "review", command: "review.start", payload: { artifactId: "original" } }), result);
  }
  const projection = projectConversations(ledger.readSince(0, 100));
  const child = projection.conversations.find(row => row.provider === "claude")!;
  assert.equal(child.name, "Review of Fix code");
  assert.equal(child.task_id, "original");
  assert.equal(child.type, "subagent");
  const relation = projection.relations.find(row => row.from_id === child.id)!;
  assert.equal(relation.to_id, '["codex","implementation"]');
  assert.equal(projection.tasks.find(task => task.id === child.task_id)!.project, "/repo");
});
