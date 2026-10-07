import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAcceptance } from "../../../core/src/accept/run.ts";
import { decide, type DecisionInput } from "../../../core/src/assign/assign.ts";
import type { ConversationPayload, Fact, FactInput, FindingPayload, JsonValue, RunPayload } from "../../../core/src/ledger/facts.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import { projectArtifacts } from "../../../core/src/ledger/projections/artifacts.ts";
import { collectArtifactSuccessors, projectApprovals } from "../../../core/src/ledger/projections/approvals.ts";
import { projectConversations } from "../../../core/src/ledger/projections/conversations.ts";
import { projectEntityRecords } from "../../../core/src/ledger/projections/delegations.ts";
import { getMessageText } from "../../../core/src/ledger/projections/messages.ts";
import { projectFindings, remapFinding } from "../../../core/src/ledger/projections/findings.ts";
import { createNativeId, projectRelations, resolveRelationTarget, serializeValue } from "../../../core/src/ledger/projections/relations.ts";
import { finalizeArtifacts } from "../artifacts/index.ts";
import type { RunnerRuntime } from "../runtime.ts";
import type { RunnerEvent, SocketRequest } from "../socket.ts";
import { buildReviewPrompt, parseReviewResult, REVIEW_OUTPUT_SCHEMA } from "../intake/review.ts";
import { collectContexts, readFindingLines } from "./contexts.ts";

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)); }
// 結果が前回と同じでも、今回の結果の事実が画面へ届いたことを確かめる。
function attachResultSequence(result: JsonValue, seq: number): JsonValue {
  return result && typeof result === "object" && !Array.isArray(result) ? { ...result, review_result_seq: seq } : result;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new TypeError("Expected nonempty text");
  return value;
}
export class ReviewFlow {
  private pending = new Map<string, Promise<JsonValue>>();
  private commands = new Map<string, { hash: string; task: Promise<JsonValue> }>();
  private ledger: Ledger;
  private runtime: RunnerRuntime;
  private decision: DecisionInput;
  private publish?: (event: RunnerEvent) => void;
  private blobDirectory: string;
  private finishRun: (runId: string) => Promise<void>;
  private failedRechecks = new Set<string>();
  private reconciling?: Promise<void>;
  private readFacts?: () => Fact[];
  private cachedFacts: Fact[] = [];
  private timestampSeq = 0;
  private lastTimestamp = 0;
  private reconciledSeq = -1;
  constructor(ledger: Ledger, runtime: RunnerRuntime, decision: DecisionInput,
    publish?: (event: RunnerEvent) => void, blobDirectory = join(process.env.XDG_STATE_HOME
      ?? join(homedir(), ".local", "state"), "agent-graph", "blobs"), finishRun?: (runId: string) => Promise<void>, readFacts?: () => Fact[]) {
    this.ledger = ledger; this.runtime = runtime; this.decision = decision; this.publish = publish;
    this.blobDirectory = blobDirectory;
    this.finishRun = finishRun ?? ((runId) => runtime.supervisor.wait(runId));
    this.readFacts = readFacts;
  }
  private facts(): Fact[] {
    if (this.readFacts) return this.readFacts();
    for (;;) {
      const batch = this.ledger.readSince(this.cachedFacts.at(-1)?.seq ?? 0, 1000);
      this.cachedFacts.push(...batch);
      if (batch.length < 1000) return this.cachedFacts;
    }
  }
  private write(kind: FactInput["kind"], subject: FactInput["subject"], payload: unknown, supersedes?: string): number {
    const facts = this.facts();
    for (let index = facts.length - 1; index >= 0 && facts[index].seq > this.timestampSeq; index--) {
      this.lastTimestamp = Math.max(this.lastTimestamp, Date.parse(facts[index].source_ts));
    }
    this.timestampSeq = facts.at(-1)?.seq ?? this.timestampSeq;
    const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    const result = this.ledger.append({ source: "ui", source_event_id: randomUUID(), source_ts: new Date(timestamp).toISOString(),
      kind, subject, payload: json(payload), confidence: "confirmed", ...(supersedes ? { supersedes } : {}) } as FactInput);
    if (result.status === "conflict") throw new Error("Conflicting review fact");
    this.lastTimestamp = timestamp;
    if (result.status === "appended") this.publish?.({ type: "evt", seq: result.seq });
    return result.seq;
  }
  private artifact(id: string) {
    const artifact = projectArtifacts(this.facts()).find((entry) => entry.id === id);
    if (!artifact?.patch_hash) throw new Error("Fixed artifact unavailable");
    return artifact;
  }
  private patch(artifact: ReturnType<ReviewFlow["artifact"]>): string {
    return artifact.diff ?? readFileSync(join(this.blobDirectory, artifact.patch_hash!), "utf8");
  }
  private run(id: string) {
    const run = projectEntityRecords<RunPayload>(this.facts(), "run").find((entry) => entry.id === id);
    if (!run?.conversation_id || !run.cwd) throw new Error("Original run unavailable");
    return run;
  }
  private provider(runId: string) {
    const run = this.run(runId);
    const conversation = projectEntityRecords<ConversationPayload>(this.facts(), "conversation").find((entry) => entry.id === run.conversation_id);
    if (!conversation?.provider) throw new Error("Conversation unavailable");
    return conversation.provider;
  }
  private findRequest(artifact: ReturnType<ReviewFlow["artifact"]>) {
    let origin = artifact;
    const visited = new Set<string>();
    while (origin.previous_artifact_id && !visited.has(origin.id)) {
      visited.add(origin.id); origin = this.artifact(origin.previous_artifact_id);
    }
    const delegation = projectEntityRecords<{ run_id: string; title: string; task: string; accept: string[];
      scope?: string[]; request: { timeoutSec?: number }; result: { output: string } }>(this.facts(), "delegation")
      .find((entry) => entry.run_id === origin.run_id);
    if (!delegation?.task || !delegation.accept) throw new Error("Original request unavailable");
    return { ...delegation, task: delegation.task, accept: delegation.accept };
  }
  private readReply(conversationId: string): string {
    const facts = this.facts();
    const memberships = projectEntityRecords<{ conversation_id: string; message_id: string; active: boolean }>(facts, "message_membership")
      .filter((entry) => entry.conversation_id === conversationId && entry.active).map((entry) => entry.message_id);
    const reply = projectEntityRecords<{ body: JsonValue; phase: string; role: string }>(facts, "message")
      .filter((entry) => memberships.includes(entry.id) && entry.role === "assistant" && entry.phase === "final_answer")
      .sort((a, b) => (facts.findLast((fact) => fact.subject === `message:${a.id}`)?.seq ?? 0)
        - (facts.findLast((fact) => fact.subject === `message:${b.id}`)?.seq ?? 0)).at(-1);
    return getMessageText(reply?.body);
  }
  command(request: SocketRequest): Promise<JsonValue> {
    const hash = createHash("sha256").update(serializeValue(json({ command: request.command, payload: request.payload }))).digest("hex");
    const receiptFact = this.facts().find((fact) => (fact.payload as { review_command?: { id: string } } | null)?.review_command?.id === request.cmd_id);
    if (receiptFact) {
      const receipt = (receiptFact.payload as unknown as { review_command: { hash: string; result: JsonValue } }).review_command;
      if (receipt.hash !== hash) return Promise.reject(new Error("Conflicting review cmd_id"));
      return Promise.resolve(attachResultSequence(receipt.result, receiptFact.seq));
    }
    const pending = this.commands.get(request.cmd_id);
    if (pending) return pending.hash === hash ? pending.task : Promise.reject(new Error("Conflicting review cmd_id"));
    const task = this.executeCommand(request).then((result) => {
      if (request.command === "review.relation_target") return result;
      const p = request.payload as Record<string, JsonValue>;
      const subject: FactInput["subject"] = typeof p.artifactId === "string" ? `artifact:${p.artifactId}`
        : typeof p.findingId === "string" ? `finding:${p.findingId}`
        : typeof p.approvalId === "string" ? `approval:${p.approvalId}`
        : this.facts().find((fact) => fact.fact_id === p.factId)!.subject;
      const entity = subject.slice(0, subject.indexOf(":"));
      const seq = this.write(`${entity}.updated` as FactInput["kind"], subject, { review_command: { id: request.cmd_id, hash, result } });
      return attachResultSequence(result, seq);
    }).finally(() => this.commands.delete(request.cmd_id));
    this.commands.set(request.cmd_id, { hash, task });
    return task;
  }
  private async executeCommand(request: SocketRequest): Promise<JsonValue> {
    const p = request.payload as Record<string, JsonValue>;
    if (!p || Array.isArray(p) || typeof p !== "object") throw new TypeError("Expected review payload");
    if (request.command === "review.relation_target") {
      const facts = this.facts();
      const conversationId = resolveRelationTarget(facts, text(p.relationId));
      const identities = new Map(projectEntityRecords<ConversationPayload>(facts, "conversation").map((entry) => [entry.id,
        entry.provider && entry.native_id ? createNativeId(entry.provider, entry.native_id) : entry.id]));
      const run = projectEntityRecords<RunPayload>(facts, "run").filter((entry) =>
        (identities.get(entry.conversation_id!) ?? entry.conversation_id) === conversationId)
        .sort((a, b) => (b.generation ?? 0) - (a.generation ?? 0))[0];
      return json({ conversationId, runId: run?.id });
    }
    if (request.command === "review.correct_relation") {
      const fact = this.facts().find((entry) => entry.fact_id === text(p.factId));
      if (!fact?.kind.startsWith("relation.")) throw new Error("Unknown relation fact");
      this.write("relation.corrected", fact.subject, { from_id: text(p.fromId), to_id: text(p.toId), confidence: "confirmed" }, fact.fact_id);
      return json(projectRelations(this.facts()));
    }
    if (request.command === "review.revoke") {
      const approval = projectApprovals(this.facts()).find((entry) => entry.id === text(p.approvalId));
      if (!approval?.artifact_id) throw new Error("Unknown artifact approval");
      this.write("approval.state_changed", `approval:${approval.id}`, { state: "revoked", reason: "User revoked approval" });
      return json(projectApprovals(this.facts()).find((entry) => entry.id === approval.id));
    }
    if (request.command === "review.finding_state") {
      const finding = projectFindings(this.facts()).find((entry) => entry.id === text(p.findingId));
      if (!finding) throw new Error("Unknown finding");
      if (!["fixed", "verified", "dismissed", "open"].includes(String(p.state))) throw new Error("Invalid finding state");
      if (p.state === "verified" && finding.state !== "fixed" && finding.state !== "needs_check") throw new Error("Finding requires revalidation");
      this.write("finding.state_changed", `finding:${finding.id}`, { state: p.state });
      return json(projectFindings(this.facts()).find((entry) => entry.id === finding.id));
    }
    const artifact = this.artifact(text(p.artifactId));
    if (request.command === "review.add_finding") {
      const start = Number(p.startLine); const end = Number(p.endLine ?? p.startLine);
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || !["old", "new"].includes(String(p.side))) throw new Error("Invalid finding location");
      const context = collectContexts(this.patch(artifact), end - start + 1).find((entry) => entry.file === p.file
        && entry.side === p.side && entry.start_line === start && entry.end_line === end);
      if (!context) throw new Error("Location is outside fixed diff");
      const id = randomUUID();
      this.write("finding.created", `finding:${id}`, { ...context, artifact_id: artifact.id, version: artifact.version,
        body: text(p.body), severity: text(p.severity), state: "open" });
      return json(projectFindings(this.facts()).find((entry) => entry.id === id));
    }
    if (request.command === "review.send") {
      if (!Array.isArray(p.findingIds) || !p.findingIds.length || !p.findingIds.every((id) => typeof id === "string")) throw new Error("Invalid findingIds");
      const findings = [...new Set(p.findingIds)].map((id) => projectFindings(this.facts()).find((entry) => entry.id === id));
      if (findings.some((entry) => !entry || entry.artifact_id !== artifact.id || !["open", "needs_check"].includes(entry.state!))) throw new Error("Findings do not belong to this version or are already sent");
      const original = this.run(artifact.run_id);
      const runs = projectEntityRecords<RunPayload>(this.facts(), "run").filter((entry) => entry.conversation_id === original.conversation_id);
      let target = runs.find((entry) => this.runtime.supervisor.isOpen(entry.id))?.id;
      const input = { text: `Fix findings for artifact ${artifact.id} (${artifact.patch_hash}):\n${JSON.stringify(findings)}` };
      if (!target) {
        const resumed = await this.runtime.command({ type: "req", cmd_id: randomUUID(), command: "resume",
          payload: { conversationId: original.conversation_id!, input } }) as { runId: string };
        target = resumed.runId;
        this.write("run.updated", `run:${target}`, { base_sha: artifact.base_sha });
      } else {
        await this.runtime.command({ type: "req", cmd_id: randomUUID(), command: "send", payload: { runId: target, input } });
      }
      for (const finding of findings) this.write("finding.state_changed", `finding:${finding!.id}`, { state: "sent", return_run_id: target });
      return { runId: target, findingIds: json(findings.map((entry) => entry!.id)) };
    }
    if (request.command === "review.reverify") return this.reverify(artifact.id, typeof p.previousArtifactId === "string" ? p.previousArtifactId : artifact.previous_artifact_id);
    if (request.command === "review.approve") {
      const successors = collectArtifactSuccessors(this.facts(), artifact.id);
      const stale = projectArtifacts(this.facts()).some((entry) => successors.has(entry.id) && entry.patch_hash !== artifact.patch_hash);
      if (stale) throw new Error("Cannot approve an obsolete patch");
      const id = randomUUID();
      this.write("approval.created", `approval:${id}`, { run_id: artifact.run_id, request_id: request.cmd_id,
        artifact_id: artifact.id, patch_hash: artifact.patch_hash, state: "approved" });
      return json(projectApprovals(this.facts()).find((entry) => entry.id === id));
    }
    if (request.command === "review.start") return this.startReview(artifact.id);
    throw new Error(`Unknown review command: ${request.command}`);
  }
  reverify(id: string, previousId?: string): Promise<JsonValue> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    const task = this.verify(id, previousId).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
  private async verify(id: string, previousId?: string): Promise<JsonValue> {
    const artifact = this.artifact(id);
    const previous = previousId ? this.artifact(previousId) : undefined;
    if (previous) {
      const oldRun = this.run(previous.run_id); const newRun = this.run(artifact.run_id);
      if (previous.repository_id !== artifact.repository_id || previous.worktree_id !== artifact.worktree_id
        || oldRun.conversation_id !== newRun.conversation_id || (oldRun.id === newRun.id
          ? artifact.version <= previous.version : newRun.generation! <= oldRun.generation!)) throw new Error("Unrelated or non-successor artifact");
      this.write("artifact.updated", `artifact:${artifact.id}`, { previous_artifact_id: previous.id });
    }
    const delegation = this.findRequest(previous ?? artifact);
    const run = this.run(artifact.run_id);
    const provider = this.provider(run.id);
    const capture = () => finalizeArtifacts(this.ledger, { runId: run.id, provider, sourceEventId: randomUUID(), sourceTs: new Date().toISOString() }, { blobDirectory: this.blobDirectory });
    if (capture()?.patch_hash !== artifact.patch_hash) throw new Error("Worktree differs from fixed artifact");
    const verification = await runAcceptance({ commands: delegation.accept, cwd: run.cwd!, baseRef: artifact.base_sha,
      scope: delegation.scope, timeoutMs: delegation.request?.timeoutSec === undefined ? undefined : delegation.request.timeoutSec * 1000 });
    if (capture()?.patch_hash !== artifact.patch_hash) throw new Error("Artifact changed during verification");
    this.write("artifact.updated", `artifact:${artifact.id}`, { verification, ...(previous ? { previous_artifact_id: previous.id } : {}) });
    if (previous) {
      const patch = this.patch(artifact);
      const previousPatch = this.patch(previous);
      for (const finding of projectFindings(this.facts()).filter((entry) => entry.artifact_id === previous.id && !["dismissed"].includes(entry.state!))) {
        const mapped = remapFinding(finding, { artifact_id: artifact.id, version: artifact.version },
          collectContexts(patch, finding.end_line! - finding.start_line! + 1));
        if (finding.state === "sent" && mapped.state !== "needs_check") {
          const location = { file: finding.file!, side: finding.side!, start_line: finding.start_line!, end_line: finding.end_line! };
          const oldLines = readFindingLines(previousPatch, location);
          const newLines = readFindingLines(patch, { ...location, start_line: mapped.start_line!, end_line: mapped.end_line! });
          // 内容の変更を修正候補とし、解決の確認は利用者か別系統のレビュアーに任せる。
          mapped.state = oldLines && newLines && JSON.stringify(oldLines) !== JSON.stringify(newLines) ? "fixed" : "needs_check";
        }
        this.write("finding.updated", `finding:${finding.id}`, { artifact_id: mapped.artifact_id, version: mapped.version,
          file: mapped.file, side: mapped.side, start_line: mapped.start_line, end_line: mapped.end_line,
          context_hash: mapped.context_hash, state: mapped.state });
      }
    }
    return json({ artifactId: artifact.id, verification });
  }
  reconcile(): Promise<void> {
    this.reconciling ??= this.reconcileVersions().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileVersions(): Promise<void> {
    const facts = this.facts();
    const seq = facts.at(-1)?.seq ?? 0;
    if (seq === this.reconciledSeq) return;
    const findings = projectFindings(facts) as (Partial<FindingPayload> & { id: string; return_run_id?: string })[];
    const artifacts = projectArtifacts(facts);
    for (const finding of findings.filter((entry) => entry.state === "sent" && entry.return_run_id)) {
      const previous = artifacts.find((entry) => entry.id === finding.artifact_id);
      if (!previous) continue;
      const next = artifacts.filter((entry) => entry.run_id === finding.return_run_id && entry.id !== previous.id
        && (entry.run_id !== previous.run_id || entry.version > previous.version)).at(-1);
      const run = next && this.run(next.run_id);
      if (next && (!this.runtime.supervisor.isOpen(next.run_id) || run?.state === "idle") && !this.failedRechecks.has(next.id)) {
        try { await this.reverify(next.id, previous.id); }
        catch (error) {
          this.failedRechecks.add(next.id);
          this.write("artifact.updated", `artifact:${next.id}`, { verification: { passed: false,
            reason: error instanceof Error ? error.message : String(error) } });
        }
      }
    }
    this.reconciledSeq = seq;
  }
  private async startReview(id: string): Promise<JsonValue> {
    const artifact = this.artifact(id);
    const family = this.provider(artifact.run_id) === "codex" ? "openai" : "anthropic";
    const selected = decide({ role: "review", title: "Artifact review", task: "Review fixed artifact", accept: [],
      constraints: { excludeFamily: [family] } }, { ...this.decision, implementerFamily: family });
    if (!selected.ok) throw new Error(selected.reason.join("\n"));
    const delegation = this.findRequest(artifact);
    const runId = randomUUID(); const conversationId = randomUUID();
    const original = this.run(artifact.run_id);
    const projection = projectConversations(this.facts());
    const originalRecord = projectEntityRecords<ConversationPayload>(this.facts(), "conversation").find((entry) => entry.id === original.conversation_id);
    const originalId = originalRecord?.provider && originalRecord.native_id
      ? createNativeId(originalRecord.provider, originalRecord.native_id) : original.conversation_id;
    const conversation = projection.conversations.find((entry) => entry.id === originalId);
    this.write("conversation.created", `conversation:${conversationId}`, {
      provider: selected.assignment.executor, native_id: conversationId, origin: "managed", type: "subagent", history_format: "jsonl",
      task_id: conversation?.task_id, name: `Review of ${conversation?.name || delegation.title}`,
    });
    this.write("relation.created", `relation:${runId}`, { type: "review_of", from_id: conversationId,
      to_id: original.conversation_id!, active: true, confidence: "confirmed",
      evidence: { artifact_id: artifact.id, patch_hash: artifact.patch_hash } });
    await this.runtime.supervisor.start(selected.assignment.executor, { runId, conversationId, generation: 1,
      cwd: this.run(artifact.run_id).cwd!, model: { model: selected.assignment.model },
      input: { text: buildReviewPrompt({ request: { title: delegation.title!, task: delegation.task, accept: delegation.accept!, scope: delegation.scope },
        reply: this.readReply(this.run(artifact.run_id).conversation_id!) || delegation.result?.output || "",
        artifact: { ...artifact, diff: this.patch(artifact), findings: projectFindings(this.facts()).filter((entry) => entry.artifact_id === artifact.id) } }) }, outputSchema: json(REVIEW_OUTPUT_SCHEMA) as { [key: string]: JsonValue } });
    await this.finishRun(runId);
    const result = parseReviewResult(this.readReply(conversationId));
    // レビュアーが作業ツリーを変えた場合も、新版を残して固定版の承認を無効にする。
    finalizeArtifacts(this.ledger, { runId: artifact.run_id, provider: this.provider(artifact.run_id),
      sourceEventId: randomUUID(), sourceTs: new Date().toISOString() }, { blobDirectory: this.blobDirectory });
    const successors = collectArtifactSuccessors(this.facts(), artifact.id);
    if (result.verdict === "approve" && !projectArtifacts(this.facts()).some((entry) => successors.has(entry.id)
      && entry.patch_hash !== artifact.patch_hash)) {
      for (const finding of projectFindings(this.facts()).filter((entry) => entry.artifact_id === artifact.id
        && entry.state === "fixed")) {
        this.write("finding.state_changed", `finding:${finding.id}`, { state: "verified" });
      }
    }
    const approvalId = randomUUID();
    this.write("approval.created", `approval:${approvalId}`, { run_id: artifact.run_id, request_id: runId,
      artifact_id: artifact.id, patch_hash: artifact.patch_hash, state: result.verdict === "approve" ? "approved" : "rejected",
      request: { result, reviewer: selected.assignment, reviewer_run_id: runId } });
    return json(projectApprovals(this.facts()).find((entry) => entry.id === approvalId));
  }
  async close(): Promise<void> { await this.reconciling; await Promise.allSettled([...this.pending.values(), ...[...this.commands.values()].map((entry) => entry.task)]); }
}
