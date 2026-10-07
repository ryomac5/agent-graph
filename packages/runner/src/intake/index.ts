import { readProjection } from "../projection.ts";
import { randomUUID } from "node:crypto";
import { decide, type DecisionInput } from "../../../core/src/assign/assign.ts";
import { loadPolicy } from "../../../core/src/assign/policy.ts";
import { runAcceptance } from "../../../core/src/accept/run.ts";
import type { Assignment, DelegateResult } from "../../../core/src/delegate/types.ts";
import { fingerprintRequest, retryStatus, transitionStatus, validateRequest, type IntakeRequest, type IntakeStatus } from "../../../core/src/intake/index.ts";
import type { ConversationPayload, FactInput, JsonValue, RunPayload } from "../../../core/src/ledger/facts.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import type { RunnerRuntime } from "../runtime.ts";
import type { RunnerEvent, SocketRequest } from "../socket.ts";
import type { WorktreeRecord } from "../worktree.ts";
import type { StartRequest } from "../host/contract.ts";
import { finalizeArtifactsAsync } from "../artifacts/index.ts";
import { ReviewFlow } from "../review/index.ts";
import { buildReviewPrompt, parseReviewResult, REVIEW_OUTPUT_SCHEMA } from "./review.ts";

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
const TURN_CHECK_INTERVAL_MS = 500;
interface StoredRequest { request?: IntakeRequest; request_hash?: string }
export interface IntakeOptions {
  decision?: DecisionInput;
  cwd?: string;
  publish?: (event: RunnerEvent) => void;
  reviewBlobDirectory?: string;
}

export class Intake {
  private ledger: Ledger;
  private runtime: RunnerRuntime;
  private options: IntakeOptions;
  private decision: DecisionInput;
  private tasks = new Map<string, Promise<void>>();
  private scheduled = new Map<string, NodeJS.Immediate>();
  private launches = new Set<Promise<unknown>>();
  private closing = false;
  private originSeq = -1;
  private lastTimestamp = 0;
  readonly review: ReviewFlow;
  private reviewTimer: NodeJS.Timeout;
  constructor(ledger: Ledger, runtime: RunnerRuntime, options: IntakeOptions = {}) {
    this.ledger = ledger; this.runtime = runtime; this.options = options;
    this.decision = options.decision ?? { policy: loadPolicy(), quota: () => undefined, performance: () => undefined };
    this.review = new ReviewFlow(ledger, runtime, this.decision, options.publish, options.reviewBlobDirectory, (runId) => this.finishRun(runId));
    this.reviewTimer = setInterval(() => {
      if (readProjection(this.ledger).rows("findings", "state = 'sent'").length) {
        void this.review.reconcile().catch((error: unknown) => { console.error("Review reconciliation failed", error); });
      }
    }, TURN_CHECK_INTERVAL_MS);
    this.reviewTimer.unref();
  }
  private readDelegations() { return readProjection(this.ledger).delegations(); }
  private write(kind: FactInput["kind"], subject: FactInput["subject"], payload: unknown, confidence: "confirmed" | "unknown" = "confirmed"): void {
    const ts = Math.max(readProjection(this.ledger).timestamp() + 1, this.lastTimestamp + 1, Date.now());
    this.lastTimestamp = ts;
    const result = this.ledger.append({ source: "intake", source_event_id: randomUUID(), source_ts: new Date(ts).toISOString(),
      kind, subject, confidence, payload: json(payload) } as FactInput);
    if (result.status === "conflict") throw new Error("Conflicting intake fact");
    if (result.status === "appended") this.options.publish?.({ type: "evt", seq: result.seq });
  }
  list(): IntakeStatus[] {
    return this.readDelegations().map((d) => ({ requestId: d.request_id, state: d.state, attempt: d.attempt,
      ...(d.attempts.at(-1)?.result === undefined ? {} : { result: d.attempts.at(-1)!.result as unknown as DelegateResult }) }));
  }
  status(requestId: string): IntakeStatus {
    const d = readProjection(this.ledger).row("delegations", requestId);
    const result = d && { requestId: d.request_id, state: d.state, attempt: d.attempt, ...(d.attempts.at(-1)?.result === undefined ? {} : { result: d.attempts.at(-1)!.result as unknown as DelegateResult }) };
    if (!result) throw new Error("Unknown requestId");
    return result;
  }
  private request(requestId: string): IntakeRequest {
    const saved = readProjection(this.ledger).record<StoredRequest>("delegation", requestId)?.request;
    if (!saved) throw new Error("Request body unavailable; cannot execute delegation");
    validateRequest(saved);
    return saved;
  }
  submit(value: unknown): IntakeStatus {
    if (this.closing) throw new Error("Intake is closing");
    validateRequest(value);
    // 呼び出し元の変更が受理済みの依頼を変えないよう、境界でコピーする。
    const request = JSON.parse(JSON.stringify(value)) as IntakeRequest;
    const existing = readProjection(this.ledger).record<StoredRequest>("delegation", request.requestId);
    if (existing) {
      if (existing.request_hash !== fingerprintRequest(request)) throw new Error("Conflicting requestId");
      if (this.status(request.requestId).state === "received") {
        this.change(request.requestId, "accepted");
        this.schedule(request.requestId);
      }
      return this.status(request.requestId);
    }
    this.write("delegation.created", `delegation:${request.requestId}`, {
      request_id: request.requestId, parent_run_id: request.parentRun,
      origin: request.origin && { provider: request.origin.provider, native_id: request.origin.nativeId },
      role: request.role, title: request.title, task: request.task, accept: request.accept, scope: request.scope,
      cwd: request.cwd, constraints: request.constraints, request, request_hash: fingerprintRequest(request), state: "received", attempt: 1,
    });
    this.change(request.requestId, "accepted");
    this.schedule(request.requestId);
    return this.status(request.requestId);
  }
  retry(requestId: string): IntakeStatus {
    if (this.closing) throw new Error("Intake is closing");
    const next = retryStatus(this.status(requestId));
    this.request(requestId);
    this.write("delegation.attempt_created", `delegation:${requestId}`, { attempt: next.attempt, state: next.state });
    this.schedule(requestId);
    return this.status(requestId);
  }
  private change(requestId: string, state: IntakeStatus["state"], fields: object = {}): void {
    const next = transitionStatus(this.status(requestId), state);
    this.write("delegation.state_changed", `delegation:${requestId}`, { attempt: next.attempt, state, ...fields });
  }
  private schedule(requestId: string): void {
    if (this.scheduled.has(requestId) || this.tasks.has(requestId)) return;
    // 受理の応答が返るまでホストを起動しない。
    this.scheduled.set(requestId, setImmediate(() => {
      this.scheduled.delete(requestId);
      const task = this.execute(requestId).finally(() => this.tasks.delete(requestId));
      this.tasks.set(requestId, task);
      void task.catch(() => {});
    }));
  }
  async wait(requestId: string): Promise<IntakeStatus> {
    if (this.scheduled.has(requestId)) await new Promise<void>((resolve) => setImmediate(resolve));
    await this.tasks.get(requestId);
    return this.status(requestId);
  }
  private readRun(runId: string) {
    const run = readProjection(this.ledger).record<RunPayload & WorktreeRecord>("run", runId);
    if (!run?.cwd || !run.base_sha || !run.repository_id || !run.worktree_id) throw new Error("Run worktree unavailable");
    return run;
  }
  private readOutput(runId: string): string {
    const store = readProjection(this.ledger);
    const run = store.record<RunPayload>("run", runId);
    const messages = run?.conversation_id ? store.messages(run.conversation_id).filter((m) => m.role === "assistant") : [];
    const final = messages.filter((m) => m.phase === "final_answer");
    return (final.length ? final : messages.slice(-1)).flatMap((m) => typeof m.body === "string" ? [m.body]
      : Array.isArray(m.body) ? m.body.flatMap((block) => block && typeof block === "object" && !Array.isArray(block) && typeof block.text === "string" ? [block.text] : []) : []).join("\n");
  }
  private async launch(runId: string, conversationId: string, assignment: Assignment, cwd: string, text: string,
    outputSchema?: StartRequest["outputSchema"]): Promise<void> {
    if (this.closing) throw new Error("interrupted");
    const launch = this.runtime.supervisor.start(assignment.executor, { runId, conversationId, generation: 1, cwd,
      input: { text }, model: { model: assignment.model }, env: { AGENT_GRAPH_MANAGED: runId }, ...(outputSchema ? { outputSchema } : {}) });
    this.launches.add(launch);
    try { await launch; } finally { this.launches.delete(launch); }
    this.reconcileOrigins();
  }
  private async finishRun(runId: string): Promise<void> {
    const saved = readProjection(this.ledger).record<RunPayload>("run", runId);
    const initialEvidence = saved?.last_evidence;
    if (initialEvidence && typeof initialEvidence === "object" && !Array.isArray(initialEvidence)
      && (initialEvidence.outcome === "interrupted" || initialEvidence.status === "interrupted")) throw new Error("interrupted");
    if (saved?.state === "ended" && !this.runtime.supervisor.isOpen(runId)) return;
    const finished = this.runtime.supervisor.wait(runId);
    // 終了は監督で待ち、接続を保つホストのターン完了だけ続きから確認する。
    let ended = false;
    const completion = finished.finally(() => { ended = true; });
    void completion.catch(() => {});
    while (!ended && this.runtime.supervisor.isOpen(runId)) {
      const run = readProjection(this.ledger).record<RunPayload>("run", runId);
      const evidence = run?.last_evidence;
      const outcome = evidence && typeof evidence === "object" && !Array.isArray(evidence)
        ? evidence.outcome ?? evidence.status : undefined;
      if (run?.state === "idle" && ["completed", "interrupted"].includes(String(outcome))) {
        await this.runtime.command({ type: "req", cmd_id: randomUUID(), command: "close", payload: { runId } });
        if (outcome === "interrupted") throw new Error("interrupted");
        break;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([completion, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TURN_CHECK_INTERVAL_MS);
        })]);
      } finally { clearTimeout(timer); }
    }
    await finished;
    const run = readProjection(this.ledger).record<RunPayload>("run", runId);
    const evidence = run?.last_evidence;
    if (evidence && typeof evidence === "object" && !Array.isArray(evidence)
      && (evidence.outcome === "interrupted" || evidence.status === "interrupted")) throw new Error("interrupted");
    if (run?.state !== "ended") throw new Error(run?.state === "unknown" || run?.reason === "interrupted" ? "interrupted" : run?.cause ?? "Run failed");
  }
  private async captureArtifact(runId: string) {
    const run = this.readRun(runId);
    const provider = readProjection(this.ledger).record<ConversationPayload>("conversation", run.conversation_id!)!.provider!;
    const artifact = await finalizeArtifactsAsync(this.ledger, { runId, provider, sourceEventId: randomUUID(), sourceTs: new Date().toISOString() }, { blobDirectory: this.options.reviewBlobDirectory });
    if (!artifact) throw new Error("Artifact unavailable");
    return artifact;
  }
  private async execute(requestId: string, recovering = false): Promise<void> {
    let result: DelegateResult | undefined;
    try {
      const request = this.request(requestId);
      const attempt = this.status(requestId).attempt;
      const savedAttempt = readProjection(this.ledger).row("delegations", requestId)!.attempts.at(-1)!;
      if (!recovering && this.status(requestId).state !== "accepted") return;
      const selected = recovering
        ? { ok: true as const, assignment: savedAttempt.assignment as unknown as Assignment }
        : decide(request, this.decision);
      if (!selected.ok) { this.change(requestId, "denied", { reason: selected.reason.join("\n") }); return; }
      const runId = recovering ? savedAttempt.run_id! : randomUUID();
      const conversationId = recovering ? this.readRun(runId).conversation_id! : randomUUID();
      if (!recovering) {
        this.change(requestId, "assigned", { run_id: runId, assignment: selected.assignment });
        await this.launch(runId, conversationId, selected.assignment, request.cwd ?? this.options.cwd ?? process.cwd(), request.task);
      }
      if (this.status(requestId).state === "assigned") this.change(requestId, "running");
      if (this.status(requestId).state === "running") {
        await this.finishRun(runId);
        this.change(requestId, "verifying");
      }
      const tree = this.readRun(runId);
      const fixedArtifact = await this.captureArtifact(runId);
      const acceptance = await runAcceptance({ commands: request.accept, cwd: tree.cwd!, scope: request.scope, baseRef: fixedArtifact.base_sha,
        timeoutMs: request.timeoutSec === undefined ? undefined : request.timeoutSec * 1000 });
      const captured = await this.captureArtifact(runId);
      if (captured.patch_hash !== fixedArtifact.patch_hash) throw new Error("Artifact changed after verification");
      const artifact = { ...captured, verification: json(acceptance) };
      const artifactId = artifact.id;
      this.write("artifact.updated", `artifact:${artifactId}`, { verification: acceptance });
      result = { delegationId: requestId, traceId: requestId, spanId: runId, status: "failed", assignment: selected.assignment,
        output: this.readOutput(runId), acceptance, usage: { inputTokens: 0, outputTokens: 0 }, roundTrips: 0 };
      this.write("delegation.attempt_created", `delegation:${requestId}`, { attempt, verification: acceptance });
      if (!acceptance.passed) { this.change(requestId, "failed", { result, reason: "Acceptance failed" }); return; }
      const savedReview = savedAttempt.review as { run_id?: string; assignment?: Assignment } | undefined;
      const reviewer = savedReview?.assignment ? { ok: true as const, assignment: savedReview.assignment } : decide({ role: "review", title: request.title, task: request.task, accept: [],
        constraints: { excludeFamily: [selected.assignment.family] } }, { ...this.decision, implementerFamily: selected.assignment.family });
      if (!reviewer.ok) { this.change(requestId, "failed", { result, reason: reviewer.reason.join("\n") }); return; }
      if (this.status(requestId).state === "verifying") this.change(requestId, "reviewing");
      const reviewRunId = savedReview?.run_id ?? randomUUID();
      const reviewConversationId = randomUUID();
      if (!savedReview?.run_id) {
        this.write("delegation.attempt_created", `delegation:${requestId}`, { attempt,
          review: { run_id: reviewRunId, artifact_id: artifactId, patch_hash: artifact.patch_hash, assignment: reviewer.assignment } });
        await this.launch(reviewRunId, reviewConversationId, reviewer.assignment, tree.cwd!,
          buildReviewPrompt({ request, reply: result.output, artifact }), json(REVIEW_OUTPUT_SCHEMA) as StartRequest["outputSchema"]);
        this.write("relation.created", `relation:${reviewRunId}`, { type: "review_of", from_id: reviewConversationId,
          to_id: conversationId, active: true, confidence: "confirmed", evidence: { artifact_id: artifactId, patch_hash: artifact.patch_hash } });
      } else {
        const saved = readProjection(this.ledger).record<RunPayload>("run", reviewRunId);
        if (!saved || saved.state !== "ended" && !this.runtime.supervisor.isOpen(reviewRunId)) throw new Error("interrupted");
      }
      await this.finishRun(reviewRunId);
      const output = this.readOutput(reviewRunId);
      const review = parseReviewResult(output);
      // 検証後の変更を承認に使わない。
      if ((await this.captureArtifact(runId)).patch_hash !== artifact.patch_hash) throw new Error("Artifact changed during review");
      result.review = { verdict: review.verdict as "approve" | "request_changes", comment: review.comment, reviewer: savedReview?.assignment ?? reviewer.assignment };
      result.status = review.verdict === "approve" ? "done" : "failed";
      this.write("delegation.attempt_created", `delegation:${requestId}`, { attempt,
        review: { ...result.review, run_id: reviewRunId, artifact_id: artifactId, patch_hash: artifact.patch_hash } });
      this.change(requestId, result.status, { result });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const state = this.status(requestId).state;
      if (!["done", "failed", "denied", "interrupted"].includes(state)) this.change(requestId, reason === "interrupted" ? "interrupted" : "failed", { reason, result });
    }
  }
  reconcileOrigins(): void {
    const store = readProjection(this.ledger);
    if (this.originSeq === store.lastSeq()) return;
    this.originSeq = store.lastSeq();

    for (const d of this.readDelegations()) {
      for (const attempt of d.attempts) {
        if (!attempt.run_id) continue;
        const child = store.record<RunPayload>("run", attempt.run_id)?.conversation_id;
        if (!child) continue;
        const parent = d.parent_run_id ? store.record<RunPayload>("run", d.parent_run_id)?.conversation_id
          : d.origin ? (() => {
            const matches = store.records<ConversationPayload>("conversation", "provider = ? AND native_id = ?", [d.origin!.provider, d.origin!.native_id]);
            return matches.length === 1 ? matches[0].id : undefined;
          })() : undefined;
        const subject = `relation:intake:${JSON.stringify([d.request_id, attempt.attempt])}` as const;
        const confidence = parent ? "confirmed" : "unknown";
        if (store.subjectFacts(subject).some((f) => f.kind === "relation.corrected")) continue;
        const previous = store.lastFact(subject);
        if (previous?.confidence === confidence && previous.payload && "from_id" in previous.payload && previous.payload.from_id === parent) continue;
        this.write(previous ? "relation.updated" : "relation.created", subject, { type: "delegated", from_id: parent,
          to_id: child, active: true, confidence, evidence: { request_id: d.request_id, attempt: attempt.attempt,
            ...(d.parent_run_id ? { parent_run_id: d.parent_run_id } : { origin: d.origin }) } }, confidence);
      }
    }
  }
  async recover(): Promise<void> {
    this.reconcileOrigins();
    for (const d of this.readDelegations()) {
      if (["done", "failed", "interrupted", "denied"].includes(d.state)) continue;
      const attempt = d.attempts.at(-1);
      if (d.state === "received") this.change(d.request_id, "accepted");
      if (!attempt?.run_id) { this.schedule(d.request_id); continue; }
      if (this.tasks.has(d.request_id)) continue;
      const run = readProjection(this.ledger).record<RunPayload>("run", attempt.run_id);
      // 起動済みの試行は監督の保持した子と保存済みの成果から続ける。
      if (this.runtime.supervisor.isOpen(attempt.run_id) || run?.state === "ended") {
        const task = this.execute(d.request_id, true);
        this.tasks.set(d.request_id, task);
        void task.finally(() => this.tasks.delete(d.request_id)).catch(() => {});
      } else this.change(d.request_id, "interrupted", { reason: "Runner restarted; explicit retry required" });
    }
  }
  command(request: SocketRequest): JsonValue | Promise<JsonValue> {
    if (request.command.startsWith("review.")) return this.review.command(request);
    const p = request.payload as Record<string, JsonValue> | undefined;
    if (request.command === "intake.submit") return json(this.submit(p));
    if (request.command === "intake.list") return json(this.list());
    if (request.command === "intake.status" || request.command === "intake.retry") {
      if (typeof p?.requestId !== "string") throw new TypeError("Invalid requestId");
      return json(request.command === "intake.status" ? this.status(p.requestId) : this.retry(p.requestId));
    }
    return this.runtime.command(request);
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.reviewTimer);
    for (const task of this.scheduled.values()) clearImmediate(task);
    this.scheduled.clear();
    await Promise.allSettled(this.launches);
    await this.runtime.close();
    await this.review.close();
    await Promise.allSettled(this.tasks.values());
  }
}
