import { randomUUID } from "node:crypto";
import type { Fact, FactInput, Provider } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import { projectDelegations, projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import type { ConversationPayload } from "../../core/src/ledger/facts.ts";
import type { AgentHost, HostEvent, RunHandle, StartRequest, ResumeRequest, ForkRequest } from "./host/contract.ts";
import type { RunnerEvent } from "./socket.ts";

const ACTIVE_STATES = new Set(["starting", "running", "waiting_approval", "waiting_input"]);
const TERMINAL_DELEGATIONS = new Set(["done", "failed", "interrupted", "denied"]);
const READ_BATCH_SIZE = 1000;
export interface UpdateStatus { activeRuns: number; activeDelegations: number }

export class Supervisor {
  private hosts = new Map<Provider, AgentHost>();
  private tasks = new Map<string, Promise<void>>();
  private facts: Fact[] = [];
  private epoch = randomUUID();
  private counter = 0;
  private lastTimestamp = 0;
  private updating = false;
  private ledger: Ledger;
  private publish: (event: RunnerEvent) => void;

  constructor(ledger: Ledger, publish: (event: RunnerEvent) => void = () => {}) {
    this.ledger = ledger;
    this.publish = publish;
    this.recover();
  }
  registerHost(host: AgentHost): void {
    if (this.hosts.has(host.provider)) throw new Error("Host already registered");
    this.hosts.set(host.provider, host);
  }
  private readFacts(): Fact[] {
    for (;;) {
      const batch = this.ledger.readSince(this.facts.at(-1)?.seq ?? 0, READ_BATCH_SIZE);
      this.facts.push(...batch);
      if (batch.length < READ_BATCH_SIZE) return this.facts;
    }
  }
  private stamp(): { source_event_id: string; source_ts: string } {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return { source_event_id: `${this.epoch}:${String(++this.counter).padStart(12, "0")}`, source_ts: new Date(this.lastTimestamp).toISOString() };
  }
  private append(fact: FactInput): void {
    const result = this.ledger.append(fact);
    if (result.status === "conflict") throw new Error("Conflicting host event");
    if (result.status === "appended") this.publish({ type: "evt", seq: result.seq });
  }
  private findManagedRuns() {
    const facts = this.readFacts();
    const managed = new Map(projectEntityRecords<ConversationPayload>(facts, "conversation")
      .filter((conversation) => conversation.origin === "managed").map((conversation) => [conversation.id, conversation.provider!]));
    return projectRuns(facts).filter((run) => managed.has(run.conversation_id)).map((run) => {
      const creation = facts.findLast((fact) => fact.kind === "run.created"
        && fact.payload?.conversation_id === run.conversation_id && fact.payload.generation === run.generation);
      return { ...run, subject: creation!.subject as `run:${string}`, provider: managed.get(run.conversation_id)! };
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
    const facts = this.readFacts();
    this.lastTimestamp = Math.max(0, ...facts.slice(-READ_BATCH_SIZE).map((fact) => Date.parse(fact.source_ts)));
    const approvals = projectApprovals(facts);
    const managedIds = new Set(this.findManagedRuns().map((run) => run.subject.slice(4)));
    this.markUnknown("restart");
    for (const approval of approvals) {
      if (approval.run_id && managedIds.has(approval.run_id) && ["pending", "requested", "waiting", "waiting_approval"].includes(approval.state)) {
        const source = facts.findLast((fact) => fact.subject === `approval:${approval.id}`)?.source;
        if (source !== "host-claude" && source !== "host-codex") continue;
        this.append({ ...this.stamp(), source, kind: "approval.resolved", subject: `approval:${approval.id}`,
          confidence: "confirmed", payload: { state: "expired", reason: "restart" } });
      }
    }
  }
  status(): UpdateStatus {
    return {
      activeRuns: this.findManagedRuns().filter((run) => ACTIVE_STATES.has(run.state)).length,
      activeDelegations: projectDelegations(this.readFacts()).filter((delegation) => !TERMINAL_DELEGATIONS.has(delegation.state)).length,
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
    if (this.readFacts().some((fact) => fact.subject === `run:${request.runId}`)) throw new Error("Run already exists");
    const source = `host-${provider}` as const;
    this.append({ ...this.stamp(), source, kind: "run.created", subject: `run:${request.runId}`, confidence: "confirmed",
      payload: { conversation_id: request.conversationId, generation: request.generation, state: "starting", started_ts: new Date().toISOString() } });
    // 起動を待つ間も、更新判定で管理対象として見えるようにする。
    if (!this.readFacts().some((fact) => fact.subject === `conversation:${request.conversationId}`)) {
      this.append({ ...this.stamp(), source, kind: "conversation.created", subject: `conversation:${request.conversationId}`, confidence: "confirmed",
        payload: { provider, native_id: "nativeId" in request ? request.nativeId : request.conversationId,
          origin: "managed", type: "interactive", history_format: "jsonl" } });
    } else {
      this.append({ ...this.stamp(), source, kind: "conversation.updated", subject: `conversation:${request.conversationId}`,
        confidence: "confirmed", payload: { origin: "managed" } });
    }
    let handle: RunHandle;
    try {
      handle = operation === "start" ? await host.start(request)
        : operation === "resume" ? await host.resume(request as ResumeRequest) : await host.fork(request as ForkRequest);
      if (handle.runId !== request.runId) throw new Error("Host returned a different run ID");
      this.append({ ...this.stamp(), source, kind: "conversation.updated", subject: `conversation:${request.conversationId}`,
        confidence: "confirmed", payload: { native_id: handle.nativeId } });
      this.append({ ...this.stamp(), source, kind: "run.updated", subject: `run:${request.runId}`,
        confidence: "confirmed", payload: { pid: handle.pid } });
    } catch (error) {
      this.append({ ...this.stamp(), source, kind: "run.state_changed", subject: `run:${request.runId}`, confidence: "confirmed",
        payload: { state: "unknown", reason: error instanceof Error ? error.message : String(error) } });
      throw error;
    }
    const task = this.consume(provider, request, handle);
    this.tasks.set(request.runId, task);
    // エラーは wait で呼び出し元へ返し、未処理の Promise 拒否を防ぐ。
    void task.catch(() => {});
    return handle;
  }
  async wait(runId: string): Promise<void> {
    const task = this.tasks.get(runId);
    if (!task) throw new Error("Unknown run");
    await task;
  }
  private async consume(provider: Provider, request: StartRequest, handle: RunHandle): Promise<void> {
    let exited = false;
    try {
      for await (const event of handle.events) {
        this.recordEvent(provider, request, event);
        if (event.type === "exit") { exited = true; break; }
      }
      if (!exited) this.recordEvent(provider, request, { type: "state", state: "unknown", reason: "host_stream_closed_without_exit" });
    } catch (error) {
      this.recordEvent(provider, request, { type: "state", state: "unknown", reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  private recordEvent(provider: Provider, request: StartRequest, event: HostEvent): void {
    if (event.type === "delta") {
      const { type, ...delta } = event;
      this.publish({ type: "evt", delta: { runId: request.runId, ...delta } });
      return;
    }
    const source = `host-${provider}` as const;
    if (event.type === "fact") { this.append({ ...event.fact, source } as FactInput); return; }
    if (event.type === "exit" && !Number.isInteger(event.exitCode)) throw new TypeError("Invalid exit code");
    const payload = event.type === "state" ? { state: event.state, reason: event.reason }
      : { state: event.exitCode === 0 ? "ended" as const : "failed" as const,
        cause: event.exitCode === 0 ? undefined : event.cause ?? `Child exited with code ${event.exitCode}`,
        end_evidence: { kind: "host_exit", exit_code: event.exitCode, ...(event.turnId ? { turn_id: event.turnId } : {}) },
        ended_ts: new Date().toISOString() };
    this.append({ ...this.stamp(), source, kind: "run.state_changed", subject: `run:${request.runId}`,
      confidence: "confirmed", payload });
  }
}
