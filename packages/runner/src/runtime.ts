import { randomUUID } from "node:crypto";
import type { ConversationPayload, Fact, FactInput, JsonValue, Provider, RunPayload } from "../../core/src/ledger/facts.ts";
import type { Ledger } from "../../core/src/ledger/ledger.ts";
import { projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { createNativeId } from "../../core/src/ledger/projections/relations.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { projectApprovals } from "../../core/src/ledger/projections/approvals.ts";
import type { AgentHost, Decision, ModelChoice, StartRequest, UserInput } from "./host/contract.ts";
import { ClaudeHost } from "./hosts/claude/index.ts";
import { CodexHost } from "./hosts/codex/index.ts";
import { Recovery, type RecoveryAction } from "./recovery.ts";
import { serveSocket, type SocketRequest, type RunnerEvent } from "./socket.ts";
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
  private readFacts() { return this.ledger.readSince(0, Number.MAX_SAFE_INTEGER); }
  private readRuns(facts: readonly Fact[] = this.readFacts()) { return projectEntityRecords<RunPayload & { launch?: { cwd: string; model: ModelChoice } }>(facts, "run") as (RunPayload & { id: string; launch?: { cwd: string; model: ModelChoice } })[]; }
  private readConversation(id: string, facts: readonly Fact[] = this.readFacts()) {
    const conversation = projectEntityRecords<ConversationPayload>(facts, "conversation").filter((entry) => entry.id === id || entry.provider && entry.native_id && createNativeId(entry.provider, entry.native_id) === id)
      .sort((a, b) => Number(b.origin === "managed") - Number(a.origin === "managed"))[0];
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
    const facts = this.readFacts();
    const timestamp = Math.max(Date.now(), ...facts.slice(-1000).map((fact) => Date.parse(fact.source_ts) + 1));
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
      const approval = projectApprovals(this.readFacts()).find((entry) => entry.id === id);
      if (!approval?.conversation_id || !["pending", "requested", "waiting", "waiting_approval"].includes(approval.state)) throw new Error("Approval is not pending");
      const decision = typeof p.decision === "string" ? p.decision : readObject(p.decision);
      if (typeof decision !== "string") readText(decision.decision, "decision");
      await this.getHost(this.readConversation(approval.conversation_id).provider).answer(id, decision as Decision);
      return { answered: id };
    }
    if (!["send", "interrupt", "set_model", "close"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const target = readText(p.runId, "runId");
    const facts = this.readFacts();
    const runs = this.readRuns(facts);
    // 実行 ID を優先し、外部 ID の照合も同じ台帳の読み取り結果から行う。
    let run = runs.find((entry) => entry.id === target);
    if (!run) {
      const native = parseNativeRunId(target);
      if (native) {
        const identities = new Map(projectEntityRecords<ConversationPayload>(facts, "conversation")
          .filter((entry) => entry.provider && entry.native_id)
          .map((entry) => [entry.id, createNativeId(entry.provider!, entry.native_id!)]));
        run = runs.find((entry) => entry.generation === native.generation
          && (identities.get(entry.conversation_id) ?? entry.conversation_id) === native.conversationId);
      }
    }
    const runId = run?.id ?? target;
    if (!run || !this.supervisor.isOpen(runId)) throw new Error("Run is not open");
    const host = this.getHost(this.readConversation(run.conversation_id, facts).provider);
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
    const facts = this.readFacts();
    const sourceRuns = source ? projectRuns(facts).filter((run) => run.conversation_id === source.id) : [];
    if (source && !["jsonl", "legacy", "paginated"].includes(source.history_format)) throw new Error("Unsupported conversation history format");
    let operation: "start" | "resume" | "fork" = command === "adopt" ? "fork" : command;
    if (command === "adopt") {
      if (p.confirmStopped !== undefined && typeof p.confirmStopped !== "boolean") throw new TypeError("Invalid confirmStopped");
      if (source!.origin !== "observed") throw new Error("Conversation is already managed");
      if (p.confirmStopped === true) {
        for (const run of this.readRuns().filter((run) => run.conversation_id === source!.id)) {
          this.write({ source: "ui", kind: "run.state_changed", subject: `run:${run.id}`, confidence: "confirmed",
            payload: { generation: run.generation, state: "ended", end_evidence: { kind: "user_correction" } } });
        }
      }
      const observedRuns = projectRuns(this.readFacts()).filter((run) => run.conversation_id === source!.id);
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
    if (command === "start" && facts.some((fact) => fact.subject === `conversation:${conversationId}`)) throw new Error("Conversation already exists");
    const saved = source ? this.readRuns().filter((run) => run.conversation_id === source.id).sort((a, b) => b.generation - a.generation)[0]?.launch : undefined;
    const req: StartRequest = { runId: p.runId === undefined ? randomUUID() : readText(p.runId, "runId"), conversationId,
      generation: operation === "resume" ? Math.max(0, ...sourceRuns.map((run) => run.generation)) + 1 : 1,
      cwd: readText(p.cwd ?? saved?.cwd, "cwd"), model: readModel(p.model ?? saved?.model), input: readInput(p.input),
      ...(p.integrationMode === "strict" ? { env: { AGENT_GRAPH_STRICT_MCP_CONFIG: "1" } } :
        p.integrationMode === "disabled" ? { env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } } : {}) };
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

export async function serveRunner(ledger: Ledger, path: string, options: { hosts?: readonly AgentHost[]; isolation?: "shared" | "worktree" } = {}) {
  const hosts = options.hosts ?? [new ClaudeHost(undefined, { enableFork: true }), new CodexHost()];
  let runtime: RunnerRuntime;
  let ready = false;
  const socket = await serveSocket(path, (request) => {
    if (!ready) throw new Error("Runner is recovering; retry with a new cmd_id");
    return runtime.command(request);
  });
  runtime = new RunnerRuntime(ledger, hosts, (event) => socket.publish(event), options.isolation);
  try { await runtime.recover(); ready = true; }
  catch (error) { await runtime.close(); await socket.close(); throw error; }
  return { runtime, async close() { ready = false; try { await runtime.close(); } finally { await socket.close(); } } };
}
