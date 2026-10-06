import { randomUUID } from "node:crypto";
import type { ConversationPayload, Fact, FactInput, Provider, RunPayload } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import { prepareProjectionFacts, projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import type { AgentHost, ResumeRequest, RunHandle } from "./host/contract.ts";
import type { RunnerEvent } from "./socket.ts";

const READ_BATCH_SIZE = 1000;
const PENDING_APPROVAL_STATES = new Set(["pending", "requested", "waiting", "waiting_approval"]);
export interface RecoveryRun { runId: string; conversationId: string; generation: number; provider: Provider; nativeId: string }
export interface RecoveryAction extends RecoveryRun { operation: "resume"; reason: string }
export interface RecoveryResult { handles: RunHandle[]; actions: RecoveryAction[] }
export interface RecoveryOptions {
  hosts: readonly AgentHost[];
  // cwd とモデルは呼び出し側が保存済みの起動設定から復元する。依頼文を再送しない。
  getRequest(run: RecoveryRun): Omit<ResumeRequest, "runId" | "conversationId" | "generation" | "nativeId" | "input"> | undefined;
  publish?: (event: RunnerEvent) => void;
  epoch?: string;
}

export class Recovery {
  private ledger: Ledger;
  private options: RecoveryOptions;
  private epoch: string;
  private timestamp = 0;
  private counter = 0;
  private result?: Promise<RecoveryResult>;
  constructor(ledger: Ledger, options: RecoveryOptions) {
    this.ledger = ledger; this.options = options; this.epoch = options.epoch ?? randomUUID();
  }
  recover(): Promise<RecoveryResult> { return this.result ??= this.recoverRuns(); }
  private append(provider: Provider, runId: string, generation: number, payload: Partial<RunPayload>): void {
    this.write({ source: `host-${provider}`, kind: "run.state_changed", subject: `run:${runId}`,
      confidence: "confirmed", payload: { ...payload, state: payload.state ?? "unknown", generation } });
  }
  private write(input: Omit<Extract<FactInput, { kind: "run.state_changed" | "approval.resolved" }>, "source_event_id" | "source_ts">): void {
    this.timestamp = Math.max(Date.now(), this.timestamp + 1);
    const result = this.ledger.append({ ...input, source_event_id: `${this.epoch}:${String(++this.counter).padStart(12, "0")}`,
      source_ts: new Date(this.timestamp).toISOString() } as FactInput);
    if (result.status === "conflict") throw new Error("Conflicting recovery fact");
    if (result.status === "appended") this.options.publish?.({ type: "evt", seq: result.seq });
  }
  private async recoverRuns(): Promise<RecoveryResult> {
    const facts: Fact[] = [];
    for (;;) {
      const batch = this.ledger.readSince(facts.at(-1)?.seq ?? 0, READ_BATCH_SIZE);
      facts.push(...batch);
      if (batch.length < READ_BATCH_SIZE) break;
    }
    for (const fact of facts) this.timestamp = Math.max(this.timestamp, Date.parse(fact.source_ts));
    const conversations = projectEntityRecords<ConversationPayload>(facts, "conversation");
    const runRecords = projectEntityRecords<RunPayload>(facts, "run");
    const active = prepareProjectionFacts(facts);
    const runs: RecoveryRun[] = [];
    const managedIds = new Set<string>();
    const projectedRuns = projectRuns(facts);
    const latestGenerations = new Map<string, number>();
    // 終了した最新世代があっても、置き換わった旧世代へ戻らない。
    for (const run of projectedRuns) {
      latestGenerations.set(run.conversation_id,
        Math.max(latestGenerations.get(run.conversation_id) ?? run.generation, run.generation));
    }
    for (const run of projectedRuns) {
      const conversation = conversations.find((entry) => entry.id === run.conversation_id);
      if (conversation?.origin !== "managed" || !conversation.provider || !conversation.native_id) continue;
      const creation = active.findLast((fact) => fact.kind === "run.created"
        && fact.payload?.conversation_id === run.conversation_id && fact.payload.generation === run.generation);
      if (!creation) continue;
      const runId = creation.subject.slice(4);
      managedIds.add(runId);
      if (run.generation !== latestGenerations.get(run.conversation_id)) continue;
      if (run.state === "ended" || run.state === "failed") continue;
      runs.push({ runId, conversationId: run.conversation_id, generation: run.generation,
        provider: conversation.provider, nativeId: conversation.native_id });
      this.append(conversation.provider, runId, run.generation, { state: "unknown", reason: "restart",
        last_evidence: run.last_evidence, last_evidence_ts: run.last_evidence_ts });
    }
    // unknown 化より前の投影で、未解消の要求を拾う。
    for (const approval of projectApprovals(facts)) {
      if (!approval.run_id || !managedIds.has(approval.run_id) || !PENDING_APPROVAL_STATES.has(approval.state)) continue;
      const conversation = conversations.find((entry) => entry.id === runRecords
        .find((run) => run.id === approval.run_id)?.conversation_id);
      if (!conversation?.provider) continue;
      this.write({ source: `host-${conversation.provider}`, kind: "approval.resolved", subject: `approval:${approval.id}`,
        confidence: "confirmed", payload: { state: "expired", reason: "restart" } });
    }
    const result: RecoveryResult = { handles: [], actions: [] };
    for (const run of runs) {
      const host = this.options.hosts.find((entry) => entry.provider === run.provider);
      if (run.provider === "claude") {
        result.actions.push({ ...run, operation: "resume", reason: "claude_child_lost_on_restart" });
        continue;
      }
      const request = this.options.getRequest(run);
      if (!host?.capabilities().resume || !request) {
        result.actions.push({ ...run, operation: "resume", reason: "host_or_request_unavailable" });
        continue;
      }
      try {
        const handle = await host.resume({ ...request, ...run, input: { text: "" } });
        if (handle.runId !== run.runId || handle.nativeId !== run.nativeId) throw new Error("Host returned a different run or thread ID");
        result.handles.push({ ...handle, events: this.observeEvents(run, handle) });
      } catch (error) {
        result.actions.push({ ...run, operation: "resume", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }
  // 消費側へすべての出来事を渡し、resume の応答だけでは unknown を解かない。
  private async *observeEvents(run: RecoveryRun, handle: RunHandle): RunHandle["events"] {
    for await (const event of handle.events) {
      if (event.type === "state") this.append(run.provider, run.runId, run.generation, { state: event.state, reason: event.reason });
      yield event;
    }
  }
}
