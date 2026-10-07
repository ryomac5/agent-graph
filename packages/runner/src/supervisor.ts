import { readProjection } from "./projection.ts";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { FactInput, Provider } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import type { ConversationPayload } from "../../core/src/ledger/facts.ts";
import type { AgentHost, HostEvent, RunHandle, StartRequest, ResumeRequest, ForkRequest } from "./host/contract.ts";
import type { RunnerEvent } from "./socket.ts";
import { recordWorktree } from "./worktree.ts";
import { finalizeArtifactsAsync, type ArtifactOptions } from "./artifacts/index.ts";

const CAPTURE_DEBOUNCE_MS = 25;
const EVENTS_PER_TICK = 2;
export interface UpdateStatus { activeRuns: number; activeDelegations: number }

export class Supervisor {
  private hosts = new Map<Provider, AgentHost>();
  private tasks = new Map<string, Promise<void>>();
  private captures = new Map<string, Promise<void>>();
  private pendingCaptures = new Set<string>();
  private openRuns = new Set<string>();

  private epoch = randomUUID();
  private counter = 0;
  private lastTimestamp = 0;
  private updating = false;
  private ledger: Ledger;
  private publish: (event: RunnerEvent) => void;

  private options: { recover?: boolean; isolation?: "shared" | "worktree"; artifacts?: ArtifactOptions };
  constructor(ledger: Ledger, publish: (event: RunnerEvent) => void = () => {}, options: { recover?: boolean; isolation?: "shared" | "worktree"; artifacts?: ArtifactOptions } = {}) {
    this.options = options;
    this.ledger = ledger;
    this.publish = publish;
    if (options.recover !== false) this.recover();
  }
  registerHost(host: AgentHost): void {
    if (this.hosts.has(host.provider)) throw new Error("Host already registered");
    this.hosts.set(host.provider, host);
  }
  private stamp(): { source_event_id: string; source_ts: string } {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1, readProjection(this.ledger).timestamp() + 1);
    return { source_event_id: `${this.epoch}:${String(++this.counter).padStart(12, "0")}`, source_ts: new Date(this.lastTimestamp).toISOString() };
  }
  private append(fact: FactInput): void {
    const result = this.ledger.append(fact);
    if (result.status === "conflict") throw new Error("Conflicting host event");
    if (result.status === "appended") this.publish({ type: "evt", seq: result.seq });
  }
  private findManagedRuns() {
    const store = readProjection(this.ledger);
    return store.rows("runs", "conversation_id IN (SELECT id FROM entity_records WHERE entity = 'conversation' AND json_extract(data, '$.origin') = 'managed')").map((run) => {
      const record = store.records<ConversationPayload>("conversation", "id = ?", [run.conversation_id])[0];
      const subject = store.runSubject(run.conversation_id, run.generation);
      return { ...run, subject: `run:${subject!}` as `run:${string}`, provider: record.provider! };
    });
  }
  private markUnknown(reason: string): void {
    for (const run of this.findManagedRuns()) {
      if (["ended", "failed", "unknown"].includes(run.state)) continue;
      this.append({ ...this.stamp(), source: `host-${run.provider}`, kind: "run.state_changed", subject: run.subject,
        confidence: "confirmed", payload: { state: "unknown", reason, generation: run.generation,
          last_evidence: run.last_evidence, last_evidence_ts: run.last_evidence_ts } });
    }
  }
  private recover(): void {
    const store = readProjection(this.ledger);
    this.lastTimestamp = store.timestamp();
    const approvals = store.rows("approvals", "state IN ('pending', 'requested', 'waiting', 'waiting_approval')");
    const managedIds = new Set(this.findManagedRuns().map((run) => run.subject.slice(4)));
    this.markUnknown("restart");
    for (const approval of approvals) {
      if (approval.run_id && managedIds.has(approval.run_id) && ["pending", "requested", "waiting", "waiting_approval"].includes(approval.state)) {
        const source = store.lastFact(`approval:${approval.id}`)?.source;
        if (source !== "host-claude" && source !== "host-codex") continue;
        this.append({ ...this.stamp(), source, kind: "approval.resolved", subject: `approval:${approval.id}`,
          confidence: "confirmed", payload: { state: "expired", reason: "restart" } });
      }
    }
  }
  status(): UpdateStatus {
    return {
      activeRuns: readProjection(this.ledger).count("SELECT count(*) AS count FROM runs r INDEXED BY runs_state JOIN entity_records c ON c.entity = 'conversation' AND c.id = r.conversation_id WHERE r.state IN ('starting', 'running', 'waiting_approval', 'waiting_input') AND json_extract(c.data, '$.origin') = 'managed'"),
      activeDelegations: readProjection(this.ledger).count("SELECT count(*) AS count FROM delegations WHERE state IN ('received', 'accepted', 'assigned', 'running', 'verifying', 'reviewing')"),
    };
  }
  prepareUpdate(force = false): UpdateStatus {
    const status = this.status();
    if (!force && (status.activeRuns || status.activeDelegations)) throw new Error("Runner update blocked by active work");
    this.updating = true;
    if (force) this.markUnknown("update");
    return status;
  }
  start(provider: Provider, request: StartRequest): Promise<RunHandle> { return this.launch(provider, request, "start"); }
  resume(provider: Provider, request: ResumeRequest): Promise<RunHandle> { return this.launch(provider, request, "resume"); }
  fork(provider: Provider, request: ForkRequest): Promise<RunHandle> { return this.launch(provider, request, "fork"); }
  private async launch(provider: Provider, request: StartRequest | ResumeRequest | ForkRequest, operation: "start" | "resume" | "fork"): Promise<RunHandle> {
    if (this.updating) throw new Error("Runner is preparing an update");
    const host = this.hosts.get(provider);
    if (!host) throw new Error(`Host unavailable: ${provider}`);
    if (!host.capabilities()[operation]) throw new Error(`Host does not support ${operation}`);
    if (readProjection(this.ledger).hasSubject(`run:${request.runId}`)) throw new Error("Run already exists");
    const source = `host-${provider}` as const;
    this.append({ ...this.stamp(), source, kind: "run.created", subject: `run:${request.runId}`, confidence: "confirmed",
      payload: { conversation_id: request.conversationId, generation: request.generation, state: "starting", started_ts: new Date().toISOString() } });
    // 起動を待つ間も、更新判定で管理対象として見えるようにする。
    if (!readProjection(this.ledger).hasSubject(`conversation:${request.conversationId}`)) {
      this.append({ ...this.stamp(), source, kind: "conversation.created", subject: `conversation:${request.conversationId}`, confidence: "confirmed",
        payload: { provider, native_id: "nativeId" in request ? request.nativeId : request.conversationId,
          origin: "managed", type: "interactive", history_format: "jsonl" } });
    } else {
      this.append({ ...this.stamp(), source, kind: "conversation.updated", subject: `conversation:${request.conversationId}`,
        confidence: "confirmed", payload: { origin: "managed" } });
    }
    let handle: RunHandle;
    try {
      if (this.options.isolation) {
        const stamp = this.stamp();
        const tree = recordWorktree(this.ledger, { runId: request.runId, generation: request.generation, provider,
          cwd: request.cwd, isolation: this.options.isolation, sourceEventId: stamp.source_event_id, sourceTs: stamp.source_ts });
        request = { ...request, cwd: tree.cwd };
        const seq = readProjection(this.ledger).lastSeq();
        this.publish({ type: "evt", seq });
      }
      this.append({ ...this.stamp(), source, kind: "run.updated", subject: `run:${request.runId}`, confidence: "confirmed",
        payload: { launch: { cwd: request.cwd, model: request.model, ...(request.integrationMode ? { integrationMode: request.integrationMode } : {}) },
          generation: request.generation } } as FactInput);
      handle = operation === "start" ? await host.start(request)
        : operation === "resume" ? await host.resume(request as ResumeRequest) : await host.fork(request as ForkRequest);
      if (handle.runId !== request.runId || operation === "resume" && handle.nativeId !== (request as ResumeRequest).nativeId) {
        await host.close(handle.runId);
        throw new Error("Host returned a different run or native ID");
      }
      this.append({ ...this.stamp(), source, kind: "conversation.updated", subject: `conversation:${request.conversationId}`,
        confidence: "confirmed", payload: { native_id: handle.nativeId } });
      this.append({ ...this.stamp(), source, kind: "run.updated", subject: `run:${request.runId}`,
        confidence: "confirmed", payload: { pid: handle.pid } });
    } catch (error) {
      this.append({ ...this.stamp(), source, kind: "run.state_changed", subject: `run:${request.runId}`, confidence: "confirmed",
        payload: { state: "unknown", reason: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    this.attach(provider, request, handle);
    return handle;
  }
  attach(provider: Provider, request: StartRequest, handle: RunHandle): void {
    this.openRuns.add(request.runId);
    const task = this.consume(provider, request, handle);
    this.tasks.set(request.runId, task);
    // エラーは wait で呼び出し元へ返し、未処理の Promise 拒否を防ぐ。
    void task.catch(() => {});
  }
  isOpen(runId: string): boolean { return this.openRuns.has(runId); }
  async wait(runId: string): Promise<void> {
    const task = this.tasks.get(runId);
    if (!task) throw new Error("Unknown run");
    await task;
  }
  private async consume(provider: Provider, request: StartRequest, handle: RunHandle): Promise<void> {
    let exited = false;
    let eventsSinceYield = 0;
    try {
      for await (const event of handle.events) {
        this.recordEvent(provider, request, event);
        if (event.type === "exit") { exited = true; break; }
        // 溜まった通知でも台帳への連続書き込みでタイマーを止めない。
        if (++eventsSinceYield === EVENTS_PER_TICK) {
          await setImmediate();
          eventsSinceYield = 0;
        }
      }
      if (!exited) this.recordEvent(provider, request, { type: "state", state: "unknown", reason: "host_stream_closed_without_exit" });
    } catch (error) {
      this.recordEvent(provider, request, { type: "state", state: "unknown", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.openRuns.delete(request.runId);
      await this.captures.get(request.runId);
    }
  }
  private recordEvent(provider: Provider, request: StartRequest, event: HostEvent): void {
    if (event.type === "delta") {
      const { type, ...delta } = event;
      this.publish({ type: "evt", delta: { runId: request.runId, ...delta } });
      return;
    }
    const source = `host-${provider}` as const;
    if (event.type === "fact") {
      this.append({ ...event.fact, source } as FactInput);
      const payload = event.fact.payload;
      const body = "body" in payload ? payload.body : undefined;
      if ((event.fact.kind === "run.updated" && "git_commit_result" in payload)
        || (event.fact.kind === "run.state_changed" && ["idle", "ended", "failed"].includes(event.fact.payload.state))
        || (event.fact.kind === "message.created" && (event.fact.payload.role === "tool" || event.fact.payload.tool_output !== undefined
          || (Array.isArray(body) && body.some((item) => item !== null && typeof item === "object" && !Array.isArray(item) && item.type === "tool_result"))))) {
        this.captureArtifacts(provider, request);
      }
      return;
    }
    if (event.type === "exit" && !Number.isInteger(event.exitCode)) throw new TypeError("Invalid exit code");
    const payload = event.type === "state" ? { state: event.state, reason: event.reason }
      : { state: event.exitCode === 0 ? "ended" as const : "failed" as const,
        cause: event.exitCode === 0 ? undefined : event.cause ?? `Child exited with code ${event.exitCode}`,
        end_evidence: { kind: "host_exit", exit_code: event.exitCode, ...(event.turnId ? { turn_id: event.turnId } : {}) },
        ended_ts: new Date().toISOString() };
    this.append({ ...this.stamp(), source, kind: "run.state_changed", subject: `run:${request.runId}`,
      confidence: "confirmed", payload });
    if (event.type === "exit" || event.state === "idle") this.captureArtifacts(provider, request);
  }
  private captureArtifacts(provider: Provider, request: StartRequest): void {
    this.pendingCaptures.add(request.runId);
    if (this.captures.has(request.runId)) return;
    const task = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_DEBOUNCE_MS));
      while (this.pendingCaptures.delete(request.runId)) await this.captureLatest(provider, request);
    })().finally(() => this.captures.delete(request.runId));
    this.captures.set(request.runId, task);
  }
  private async captureLatest(provider: Provider, request: StartRequest): Promise<void> {
    if (readProjection(this.ledger).rows("relations", "type = 'review_of' AND from_id = ?", [readProjection(this.ledger).nativeConversationId(request.conversationId)]).length) return;
    const stamp = this.stamp();
    const before = readProjection(this.ledger).lastSeq();
    try {
      await finalizeArtifactsAsync(this.ledger, { runId: request.runId, provider,
        sourceEventId: stamp.source_event_id, sourceTs: stamp.source_ts }, this.options.artifacts);
    } catch (error) {
      // 成果物の失敗は host の終了根拠とイベントの読み取りを変えない。
      this.append({ ...stamp, source: `host-${provider}`, kind: "run.updated", subject: `run:${request.runId}`,
        confidence: "confirmed", payload: { artifact_capture: { status: "failed",
          reason: error instanceof Error ? error.message : String(error) } } } as FactInput);
      return;
    }
    const after = readProjection(this.ledger).lastSeq();
    if (after !== before && after !== undefined) this.publish({ type: "evt", seq: after });
  }
}
