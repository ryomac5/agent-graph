import { readProjection } from "./projection.ts";
import { randomUUID } from "node:crypto";
import type { ConversationPayload, FactInput, JsonValue, Provider, RunPayload } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import { createNativeId } from "../../core/src/ledger/projections/relations.ts";
import { INTEGRATION_MODES, type AgentHost, type Decision, type IntegrationMode, type ModelChoice, type StartRequest, type UserInput } from "./host/contract.ts";
import { ClaudeHost, type ClaudeHostOptions } from "./hosts/claude/index.ts";

type Launch = { cwd: string; model: ModelChoice; integrationMode?: IntegrationMode };
import { CodexHost } from "./hosts/codex/index.ts";
import { Recovery, type RecoveryAction } from "./recovery.ts";
import { type SocketRequest, type RunnerEvent } from "./socket.ts";
import { serveMcpRunner } from "./mcp/index.ts";
import type { IntakeOptions } from "./intake/index.ts";
import { Supervisor } from "./supervisor.ts";

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object payload");
  return value as Record<string, unknown>;
}
function readText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`Invalid ${field}`);
  return value;
}
function readModel(value: unknown): ModelChoice {
  const model = readObject(value);
  return { model: readText(model.model, "model"), ...(model.effort === undefined ? {} : { effort: readText(model.effort, "effort") }) };
}
function readIntegrationMode(value: unknown): { integrationMode?: IntegrationMode } {
  if (value === undefined) return {};
  if (!INTEGRATION_MODES.includes(value as IntegrationMode)) throw new TypeError("Invalid integrationMode");
  return { integrationMode: value as IntegrationMode };
}
function readInput(value: unknown): UserInput {
  const input = readObject(value);
  if (typeof input.text !== "string") throw new TypeError("Invalid input text");
  if (input.attachments !== undefined) throw new TypeError("Attachments are not supported");
  return { text: input.text };
}
function toJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function parseNativeRunId(target: string): { conversationId: string; generation: number } | undefined {
  const match = /^(\[.*\]):([1-9]\d*)$/s.exec(target);
  if (!match) return;
  let identity: unknown;
  try { identity = JSON.parse(match[1]); } catch { return; }
  const generation = Number(match[2]);
  if (!Array.isArray(identity) || identity.length !== 2
    || !identity.every((value) => typeof value === "string" && value.length > 0)
    || !Number.isSafeInteger(generation)) return;
  const conversationId = createNativeId(identity[0], identity[1]);
  if (`${conversationId}:${generation}` !== target) return;
  return { conversationId, generation };
}

export class RunnerRuntime {
  readonly supervisor: Supervisor;
  private hosts: Map<Provider, AgentHost>;
  private actions: RecoveryAction[] = [];
  private opening = new Set<string>();
  private launches = new Set<Promise<JsonValue>>();
  private closing = false;
  private ledger: Ledger;
  private publish: (event: RunnerEvent) => void;
  constructor(ledger: Ledger, hosts: readonly AgentHost[], publish: (event: RunnerEvent) => void,
    isolation: "shared" | "worktree" = "shared") {
    this.ledger = ledger; this.publish = publish;
    this.hosts = new Map(hosts.map((host) => [host.provider, host]));
    this.supervisor = new Supervisor(ledger, publish, { recover: false, isolation });
    for (const host of hosts) this.supervisor.registerHost(host);
  }
  private readRuns(conversationId?: string) { return readProjection(this.ledger).records<RunPayload & { launch?: Launch }>("run", conversationId ? "conversation_id = ?" : "", conversationId ? [conversationId] : []) as (RunPayload & { id: string; launch?: Launch })[]; }
  private readConversation(id: string) {
    const conversation = readProjection(this.ledger).conversation<ConversationPayload>(id);
    if (!conversation) throw new Error("Unknown conversation");
    if (!conversation.provider || !conversation.native_id || !conversation.history_format) throw new Error("Incomplete conversation identity");
    return conversation as ConversationPayload & { id: string };
  }
  async recover(): Promise<void> {
    const runs = this.readRuns();
    const result = await new Recovery(this.ledger, { hosts: [...this.hosts.values()], publish: this.publish,
      getRequest: (run) => runs.find((entry) => entry.id === run.runId)?.launch }).recover();
    this.actions = result.actions;
    for (const handle of result.handles) {
      const run = runs.find((entry) => entry.id === handle.runId)!;
      const conversation = this.readConversation(run.conversation_id);
      this.supervisor.attach(conversation.provider, { ...run.launch!, runId: run.id, conversationId: run.conversation_id,
        generation: run.generation, input: { text: "" } }, handle);
    }
  }
  private getHost(provider: unknown): AgentHost {
    if (provider !== "claude" && provider !== "codex") throw new TypeError("Invalid provider");
    const host = this.hosts.get(provider);
    if (!host) throw new Error(`Host unavailable: ${provider}`);
    return host;
  }
  private write(input: Omit<FactInput, "source_event_id" | "source_ts">): void {
    const timestamp = Math.max(Date.now(), readProjection(this.ledger).timestamp() + 1);
    const result = this.ledger.append({ ...input, source_event_id: randomUUID(), source_ts: new Date(timestamp).toISOString() } as FactInput);
    if (result.status === "conflict") throw new Error("Conflicting command fact");
    if (result.status === "appended") this.publish({ type: "evt", seq: result.seq });
  }
  async command(request: SocketRequest): Promise<JsonValue> {
    if (this.closing) throw new Error("Runner is shutting down");
    const { command } = request;
    if (command === "status") return toJson({ ...this.supervisor.status(), recovery: this.actions,
      hosts: Object.fromEntries([...this.hosts].map(([provider, host]) => [provider, host.capabilities()])) });
    const p = request.payload === undefined ? {} : readObject(request.payload);
    if (command === "prepare_update") return toJson(this.supervisor.prepareUpdate(p.force === true));
    if (command === "start" || command === "resume" || command === "fork" || command === "adopt") {
      const launch = this.launch(command, p);
      this.launches.add(launch);
      try { return await launch; } finally { this.launches.delete(launch); }
    }
    if (command === "list_models") return toJson(await this.getHost(p.provider).listModels());
    if (command === "answer") {
      const id = readText(p.approvalId, "approvalId");
      const approval = readProjection(this.ledger).row("approvals", id);
      if (!approval?.conversation_id || !["pending", "requested", "waiting", "waiting_approval"].includes(approval.state)) throw new Error("Approval is not pending");
      const decision = typeof p.decision === "string" ? p.decision : readObject(p.decision);
      if (typeof decision !== "string") readText(decision.decision, "decision");
      await this.getHost(this.readConversation(approval.conversation_id).provider).answer(id, decision as Decision);
      return { answered: id };
    }
    if (!["send", "interrupt", "set_model", "close"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const target = readText(p.runId, "runId");
    const store = readProjection(this.ledger);
    let run = store.record<RunPayload & { launch?: Launch }>("run", target);
    if (!run) {
      const native = parseNativeRunId(target);
      const conversation = native && store.conversation<ConversationPayload>(native.conversationId);
      if (conversation) run = store.records<RunPayload & { launch?: Launch }>("run", "conversation_id = ? AND json_extract(data, '$.generation') = ?", [conversation.id, native!.generation])[0];
    }
    const runId = run?.id ?? target;
    if (!run || !this.supervisor.isOpen(runId)) throw new Error("Run is not open");
    const host = this.getHost(this.readConversation(run.conversation_id!).provider);
    if (command === "send") await host.send(runId, readInput(p.input));
    else if (command === "interrupt") await host.interrupt(runId);
    else if (command === "close") { await host.close(runId); await this.supervisor.wait(runId); }
    else {
      const model = readModel(p.model);
      await host.setModel(runId, model);
      this.write({ source: `host-${host.provider}`, kind: "run.updated", subject: `run:${runId}`, confidence: "confirmed",
        payload: { launch: { ...run.launch, model } } } as Omit<FactInput, "source_event_id" | "source_ts">);
    }
    return { runId };
  }
  private async launch(command: "start" | "resume" | "fork" | "adopt", p: Record<string, unknown>): Promise<JsonValue> {
    const source = command === "start" ? undefined : this.readConversation(readText(p.conversationId, "conversationId"));
    const host = this.getHost(source?.provider ?? p.provider);
    const store = readProjection(this.ledger);
    const sourceRuns = source ? store.rows("runs", "conversation_id = ?", [source.id]) : [];
    if (source && !["jsonl", "legacy", "paginated"].includes(source.history_format)) throw new Error("Unsupported conversation history format");
    let operation: "start" | "resume" | "fork" = command === "adopt" ? "fork" : command;
    if (command === "adopt") {
      if (p.confirmStopped !== undefined && typeof p.confirmStopped !== "boolean") throw new TypeError("Invalid confirmStopped");
      if (source!.origin !== "observed") throw new Error("Conversation is already managed");
      if (p.confirmStopped === true) {
        for (const run of this.readRuns(source!.id)) {
          this.write({ source: "ui", kind: "run.state_changed", subject: `run:${run.id}`, confidence: "confirmed",
            payload: { generation: run.generation, state: "ended", end_evidence: { kind: "user_correction" } } });
        }
      }
      const observedRuns = readProjection(this.ledger).rows("runs", "conversation_id = ?", [source!.id]);
      const latest = Math.max(0, ...observedRuns.map((run) => run.generation));
      const current = observedRuns.filter((run) => run.generation === latest);
      const stopped = p.confirmStopped === true || current.length > 0 && current.every((run) => run.state === "ended" || run.state === "failed");
      operation = stopped ? "resume" : "fork";
      if (!stopped && p.confirmStopped === undefined) return { confirmation_required: true, fallback: "fork" };
    }
    if (source?.origin === "observed" && command === "resume") throw new Error("Use adopt for observed conversations");
    const conversationId = operation === "resume" ? source!.id : command === "start"
      ? (p.conversationId === undefined ? randomUUID() : readText(p.conversationId, "conversationId")) : randomUUID();
    if (this.opening.has(conversationId) || this.readRuns().some((run) => run.conversation_id === conversationId && this.supervisor.isOpen(run.id))) throw new Error("Conversation is already open");
    if (command === "start" && store.hasSubject(`conversation:${conversationId}`)) throw new Error("Conversation already exists");
    const saved = source ? this.readRuns(source.id).sort((a, b) => b.generation - a.generation)[0]?.launch : undefined;
    const req: StartRequest = { runId: p.runId === undefined ? randomUUID() : readText(p.runId, "runId"), conversationId,
      generation: operation === "resume" ? Math.max(0, ...sourceRuns.map((run) => run.generation)) + 1 : 1,
      cwd: readText(p.cwd ?? saved?.cwd, "cwd"), model: readModel(p.model ?? saved?.model), input: readInput(p.input),
      ...readIntegrationMode(p.integrationMode ?? saved?.integrationMode) };
    this.opening.add(conversationId);
    try {
      const handle = operation === "start" ? await this.supervisor.start(host.provider, req)
        : await this.supervisor[operation](host.provider, { ...req, nativeId: source!.native_id });
      if (command === "adopt" || operation === "fork" && host.provider === "claude") this.write({ source: `host-${host.provider}`, kind: "relation.created",
        subject: `relation:${randomUUID()}`, confidence: "confirmed", payload: { type: command === "adopt" ? "adopted" : "forked",
          from_id: source!.id, to_id: command === "adopt" ? req.runId : conversationId, active: true, confidence: "confirmed", evidence: { run_id: req.runId, operation } } });
      this.actions = this.actions.filter((action) => action.conversationId !== conversationId);
      return { runId: req.runId, conversationId, nativeId: handle.nativeId, generation: req.generation, operation };
    } finally { this.opening.delete(conversationId); }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.launches]);
    const results = await Promise.allSettled([...this.hosts.values()].map(async (host) => {
      if ("dispose" in host && typeof host.dispose === "function") await host.dispose();
      else for (const run of this.readRuns()) if (this.supervisor.isOpen(run.id) && this.readConversation(run.conversation_id).provider === host.provider) await host.close(run.id);
    }));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await Promise.allSettled(this.readRuns().filter((run) => this.supervisor.isOpen(run.id)).map((run) => this.supervisor.wait(run.id)));
  }
}

export async function serveRunner(ledger: Ledger, path: string, options: IntakeOptions & { hosts?: readonly AgentHost[]; isolation?: "shared" | "worktree"; claude?: ClaudeHostOptions } = {}) {
  const hosts = options.hosts ?? [new ClaudeHost(undefined, { enableFork: true, ...options.claude }), new CodexHost()];
  return serveMcpRunner(ledger, path, { ...options, hosts });
}
