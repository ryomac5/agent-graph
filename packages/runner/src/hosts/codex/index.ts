import { randomUUID } from "node:crypto";
import type { JsonValue, FactKind, FactPayloads, RunState } from "../../../../core/src/ledger/facts.ts";
import { createNativeId } from "../../../../core/src/ledger/projections/relations.ts";
import type { AgentHost, ApprovalId, Decision, ForkRequest, HostCapabilities, HostEvent, HostFact, HostLaunchOptions, ModelChoice, ModelInfo, ResumeRequest, RunHandle, StartRequest, UserInput } from "../../host/contract.ts";
import { AppServer, type RpcMessage, type ServerOptions } from "./rpc.ts";

class EventQueue {
  private values: HostEvent[] = [];
  private wake?: () => void;
  private ended = false;
  push(event: HostEvent): void {
    if (this.ended) return;
    this.values.push(event);
    if (event.type === "exit") this.ended = true;
    this.wake?.(); this.wake = undefined;
  }
  async *read(): AsyncIterable<HostEvent> {
    while (!this.ended || this.values.length) {
      if (!this.values.length) await new Promise<void>((resolve) => { this.wake = resolve; });
      while (this.values.length) yield this.values.shift()!;
    }
  }
}
interface Thread {
  nativeId: string;
  conversationId: string;
  runId: string;
  generation: number;
  model: ModelChoice;
  outputSchema?: StartRequest["outputSchema"];
  queue: EventQueue;
  turnId?: string;
  startingTurn?: boolean;
  closed?: boolean;
  state: RunState;
}
interface Approval {
  id: string | number;
  thread: Thread;
  turnId?: string;
  available: JsonValue[];
  answered: boolean;
}
export interface CodexHostOptions extends ServerOptions, HostLaunchOptions {
  approvalPolicy?: string;
  sandbox?: string;
}

// 未知の子の事実は既存の実行のストリームで運び、subject は子自身を指す。
export class CodexHost implements AgentHost {
  readonly provider = "codex" as const;
  private options: CodexHostOptions;
  private server?: AppServer;
  private ready?: Promise<void>;
  private cleanup: Promise<void> = Promise.resolve();
  private epoch = randomUUID();
  private counter = 0;
  private lastTime = 0;
  private runs = new Map<string, Thread>();
  private threads = new Map<string, Thread>();
  private turns = new Map<string, Thread>();
  private completedTurns = new Set<string>();
  private approvals = new Map<ApprovalId, Approval>();
  private relations = new Set<string>();
  private messages = new Set<string>();
  private launching = 0;
  private deferred: RpcMessage[] = [];
  private disposed = false;

  constructor(options: CodexHostOptions = {}) { this.options = options; }
  capabilities(): HostCapabilities {
    return { start: true, resume: true, fork: true, interrupt: true, approvals: true, setModel: true, delta: true };
  }
  private async connect(req?: StartRequest): Promise<void> {
    if (this.disposed) throw new Error("Codex host is closed");
    if (!this.ready) {
      this.epoch = randomUUID();
      const server = new AppServer({ ...this.options, cwd: this.options.cwd ?? req?.cwd,
        env: { ...req?.env, ...this.options.env } }, (message) => {
        if (this.launching) this.deferred.push(message); else this.receive(message);
      }, (code, cause) => {
        for (const thread of this.threads.values()) this.expire(thread, "server_exit");
        for (const thread of this.threads.values()) {
          if (!this.runs.has(thread.runId)) this.emitFact(thread, "run.state_changed", `run:${thread.runId}`, {
            state: code === 0 ? "ended" : "failed", end_evidence: { kind: "host_exit", exit_code: code },
            ...(code !== 0 ? { cause: cause ?? `app-server exited with code ${code}` } : {}), ended_ts: new Date().toISOString() });
        }
        for (const thread of this.runs.values()) {
          thread.closed = true;
          thread.queue.push({ type: "exit", exitCode: code, cause });
        }
        this.runs.clear();
        this.threads.clear();
        this.turns.clear();
        this.completedTurns.clear();
        this.deferred = [];
        this.ready = undefined;
        this.server = undefined;
        // 異常終了したサーバーの道具の子孫も、次の接続までに止める。
        this.cleanup = server.stop();
        void this.cleanup.catch(() => {});
      });
      this.server = server;
      this.ready = (async () => {
        await this.cleanup;
        await server.request("initialize", { clientInfo: { name: "agent_graph", version: "2.0.0" }, capabilities: { experimentalApi: true } });
        server.write({ method: "initialized" });
      })();
    }
    await this.ready;
  }
  start(req: StartRequest): Promise<RunHandle> { return this.launch(req, "start"); }
  resume(req: ResumeRequest): Promise<RunHandle> { return this.launch(req, "resume"); }
  fork(req: ForkRequest): Promise<RunHandle> { return this.launch(req, "fork"); }
  private async launch(req: StartRequest | ResumeRequest, operation: "start" | "resume" | "fork"): Promise<RunHandle> {
    if (this.options.persistSession === false && operation !== "start" && !this.threads.has((req as ResumeRequest).nativeId)) {
      throw new Error("Non-persistent Codex hosts can only resume or fork their own live threads");
    }
    if (this.runs.has(req.runId)) throw new Error("Run already exists");
    const queue = new EventQueue();
    const thread: Thread = { nativeId: "", conversationId: req.conversationId, runId: req.runId,
      generation: req.generation, model: { ...req.model }, ...(req.outputSchema ? { outputSchema: req.outputSchema } : {}), queue, state: "starting" };
    this.runs.set(req.runId, thread);
    this.launching++;
    try {
      await this.connect(req);
      const result = await this.server!.request(`thread/${operation}`, {
        cwd: req.cwd, model: req.model.model,
        // 再開には ephemeral の口がないため、このホストのメモリ内の会話だけを許す。
        ...(operation !== "resume" ? { ephemeral: this.options.persistSession === false } : {}),
        approvalPolicy: this.options.approvalPolicy ?? "untrusted", sandbox: this.options.sandbox ?? "workspace-write",
        ...(operation !== "start" ? { threadId: (req as ResumeRequest).nativeId, excludeTurns: true } : {}),
      });
      thread.nativeId = result.thread.id;
      const previous = this.threads.get(thread.nativeId);
      if (previous && !previous.closed && this.runs.has(previous.runId)) throw new Error("Thread already has an open run");
      this.threads.set(thread.nativeId, thread);
      if (operation === "fork" && result.thread.forkedFromId) {
        this.relate(thread, "forked", result.thread.forkedFromId, thread.nativeId, { forkedFromId: result.thread.forkedFromId });
      }
    } catch (error) {
      this.runs.delete(req.runId);
      throw error;
    } finally {
      if (--this.launching === 0) {
        const deferred = this.deferred.splice(0);
        for (const message of deferred) this.receive(message);
      }
    }
    try { if (operation !== "resume" || req.input.text || req.input.attachments?.length) await this.send(req.runId, req.input); }
    catch (error) {
      thread.closed = true;
      this.runs.delete(req.runId);
      this.expire(thread, "start_failed");
      throw error;
    }
    return { runId: req.runId, nativeId: thread.nativeId, pid: this.server!.child.pid, events: queue.read() };
  }
  private getRun(runId: string): Thread {
    const thread = this.runs.get(runId);
    if (!thread || thread.closed) throw new Error("Unknown or closed run");
    return thread;
  }
  async send(runId: string, input: UserInput): Promise<void> {
    const thread = this.getRun(runId);
    if (thread.startingTurn || thread.turnId) throw new Error("Turn is already active");
    if (input.attachments?.length) throw new Error("Codex attachments are not supported by this host");
    thread.startingTurn = true;
    try {
      const result = await this.server!.request("turn/start", { threadId: thread.nativeId,
        model: thread.model.model, effort: thread.model.effort ?? null, input: [{ type: "text", text: input.text }],
        ...(thread.outputSchema ? { outputSchema: thread.outputSchema } : {}) });
      const key = this.turnKey(thread.nativeId, result.turn.id);
      this.turns.set(key, thread);
      if (result.turn.status === "inProgress" && !this.completedTurns.has(key)) thread.turnId = result.turn.id;
    } finally { thread.startingTurn = false; }
  }
  async setModel(runId: string, model: ModelChoice): Promise<void> {
    const thread = this.getRun(runId);
    if (thread.turnId || thread.startingTurn) throw new Error("Cannot change model during a turn");
    thread.model = { ...model };
  }
  async interrupt(runId: string): Promise<void> {
    const thread = this.getRun(runId);
    if (!thread.turnId) return;
    this.emitFact(thread, "run.interrupt_requested", `run:${runId}`, { turn_id: thread.turnId });
    await this.server!.request("turn/interrupt", { threadId: thread.nativeId, turnId: thread.turnId });
    this.expire(thread, "interrupt");
  }
  async answer(id: ApprovalId, decision: Decision): Promise<void> {
    const approval = this.approvals.get(id);
    if (!approval || approval.answered || approval.thread.closed) throw new Error("Approval is not pending");
    const result = typeof decision === "string" ? { decision } : decision;
    const selected = approval.available.find((value) =>
      (typeof value === "string" ? value : JSON.stringify(value)) === result.decision);
    if (selected === undefined) throw new Error("Decision was not offered");
    this.server!.write({ id: approval.id, result: { decision: selected } });
    approval.answered = true;
    this.emitFact(approval.thread, "approval.answered", `approval:${id}`, { decision: result.decision });
  }
  async listModels(): Promise<ModelInfo[]> {
    await this.connect();
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const result = await this.server!.request("model/list", { cursor });
      for (const model of result.data) models.push({ model: model.model, displayName: model.displayName ?? model.model, effort: model.defaultReasoningEffort });
      cursor = result.nextCursor ?? null;
    } while (cursor);
    return models;
  }
  async close(runId: string): Promise<void> {
    const thread = this.getRun(runId);
    await this.interrupt(runId);
    this.expire(thread, "close");
    thread.closed = true;
    thread.queue.push({ type: "exit", exitCode: 0 });
    this.runs.delete(runId);
  }
  async dispose(): Promise<void> {
    if (this.disposed) { await Promise.all([this.cleanup, this.server?.stop()]); return; }
    this.disposed = true;
    for (const thread of this.threads.values()) this.expire(thread, "shutdown");
    await Promise.all([this.cleanup, this.server?.stop()]);
  }
  private turnKey(threadId: string, turnId: string): string { return JSON.stringify([threadId, turnId]); }
  private identify(nativeId: string): string { return JSON.stringify(["codex", nativeId]); }
  private emitFact<K extends FactKind>(thread: Thread, kind: K, subject: HostFact["subject"], payload: FactPayloads[K]): void {
    this.lastTime = Math.max(Date.now(), this.lastTime + 1);
    thread.queue.push({ type: "fact", fact: { kind, subject, payload, confidence: "confirmed",
      source_event_id: `${this.epoch}:${String(++this.counter).padStart(12, "0")}`, source_ts: new Date(this.lastTime).toISOString() } as HostFact });
  }
  private discover(nativeId: string): Thread {
    const known = this.threads.get(nativeId);
    if (known) return known;
    const carrier = [...this.runs.values()].find((run) => !run.closed);
    if (!carrier) throw new Error("Unknown thread without an event consumer");
    const thread: Thread = { nativeId, conversationId: this.identify(nativeId), runId: `${this.epoch}:${nativeId}`,
      generation: 1, model: carrier.model, queue: carrier.queue, state: "unknown" };
    this.threads.set(nativeId, thread);
    this.emitFact(thread, "conversation.created", `conversation:${thread.conversationId}`, {
      provider: "codex", native_id: nativeId, origin: "managed", type: "subagent", history_format: "paginated" });
    this.emitFact(thread, "run.created", `run:${thread.runId}`, {
      conversation_id: thread.conversationId, generation: 1, state: "unknown" });
    return thread;
  }
  private changeState(thread: Thread, state: RunState, evidence: JsonValue): void {
    thread.state = state;
    if (state === "failed") {
      const cause = JSON.stringify(evidence);
      this.expire(thread, "run_failed");
      if (this.runs.has(thread.runId)) {
        // 共有サーバーは残し、失敗した実行だけを終了する。
        thread.closed = true;
        thread.queue.push({ type: "exit", exitCode: 1, cause, turnId: thread.turnId });
      } else {
        this.emitFact(thread, "run.state_changed", `run:${thread.runId}`, { state, generation: thread.generation, cause,
          end_evidence: { kind: "host_exit", exit_code: 1, subtype: "codex_run_failed" }, ended_ts: new Date().toISOString() });
      }
      return;
    }
    // 子の状態で親の実行を上書きしない。
    this.emitFact(thread, "run.state_changed", `run:${thread.runId}`, { state, generation: thread.generation, last_evidence: evidence });
  }
  private expire(thread: Thread, reason: string): void {
    for (const [id, approval] of this.approvals) {
      if (approval.thread !== thread) continue;
      this.emitFact(thread, "approval.resolved", `approval:${id}`, { state: "expired", reason });
      this.approvals.delete(id);
    }
  }
  private relate(carrier: Thread, type: "delegated" | "forked", from: string, to: string, evidence: JsonValue): void {
    // 分岐元の参照だけでは、会話や実行の存在・属性を確定しない。
    const fromId = type === "forked"
      ? this.threads.get(from)?.conversationId ?? createNativeId("codex", from)
      : this.discover(from).conversationId;
    const toId = this.discover(to).conversationId;
    const id = JSON.stringify([type, fromId, toId]);
    if (this.relations.has(id)) return;
    this.relations.add(id);
    this.emitFact(carrier, "relation.created", `relation:${id}`, { type, from_id: fromId, to_id: toId, evidence, confidence: "confirmed", active: true });
  }
  private receive(message: RpcMessage): void {
    const p = message.params ?? {};
    if (message.method === "serverRequest/resolved") {
      for (const [id, approval] of this.approvals) {
        if (approval.id !== p.requestId || (p.threadId && p.threadId !== approval.thread.nativeId)) continue;
        this.emitFact(approval.thread, "approval.resolved", `approval:${id}`, { state: "resolved" });
        this.approvals.delete(id);
      }
      return;
    }
    const nativeId = p.threadId ?? p.thread?.id;
    if (!nativeId) {
      if (message.id !== undefined) this.server!.write({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
      return;
    }
    const turnId = p.turnId ?? p.turn?.id;
    const thread = (turnId && this.turns.get(this.turnKey(nativeId, turnId))) ?? this.discover(nativeId);
    if (thread.closed) {
      if (message.id !== undefined) this.server!.write({ id: message.id, error: { code: -32000, message: "Run is closed" } });
      return;
    }
    if (!this.runs.has(thread.runId)) {
      const carrier = [...this.runs.values()].find((run) => !run.closed);
      if (carrier) thread.queue = carrier.queue;
    }
    if (message.id !== undefined) {
      if (message.method !== "item/commandExecution/requestApproval" && message.method !== "item/fileChange/requestApproval") {
        this.server!.write({ id: message.id, error: { code: -32601, message: "Unsupported server request" } });
        return;
      }
      const id = JSON.stringify([this.epoch, nativeId, message.id]);
      this.approvals.set(id, { id: message.id, thread, turnId: p.turnId, available: p.availableDecisions ?? [], answered: false });
      this.emitFact(thread, "approval.created", `approval:${id}`, { run_id: thread.runId, conversation_id: thread.conversationId,
        connection_id: this.epoch, request_id: String(message.id), state: "pending", request: p,
        available_decisions: (p.availableDecisions ?? []).map((value: JsonValue) => typeof value === "string" ? value : JSON.stringify(value)) });
      return;
    }
    switch (message.method) {
      case "turn/started":
        thread.turnId = p.turn.id;
        this.turns.set(this.turnKey(nativeId, p.turn.id), thread);
        this.changeState(thread, "running", { turn_id: p.turn.id });
        break;
      case "turn/completed": {
        this.completedTurns.add(this.turnKey(nativeId, p.turn.id));
        const target = this.turns.get(this.turnKey(nativeId, p.turn.id)) ?? thread;
        if (target.turnId && target.turnId !== p.turn.id) break;
        target.turnId = undefined;
        // ターンの失敗は次の入力を妨げない。実行の失敗は systemError で確定する。
        this.changeState(target, "idle", { turn_id: p.turn.id, status: p.turn.status, error: p.turn.error ?? null });
        break;
      }
      case "thread/status/changed": {
        const status = p.status;
        const flags = status.activeFlags ?? [];
        const state: RunState = status.type === "systemError" ? "failed"
          : status.type === "idle" ? "idle" : status.type === "active"
            ? flags.includes("waitingOnApproval") ? "waiting_approval" : flags.includes("waitingOnUserInput") ? "waiting_input" : "running"
            : "unknown";
        this.changeState(thread, state, status);
        break;
      }
      case "item/agentMessage/delta":
        thread.queue.push({ type: "delta", text: p.delta, conversationId: thread.conversationId, messageId: this.identify(p.itemId) });
        break;
      case "item/completed": {
        const item = p.item;
        if (item.type === "agentMessage" || item.type === "userMessage") {
          const id = this.identify(item.id);
          if (this.messages.has(id)) break;
          this.messages.add(id);
          this.emitFact(thread, "message.created", `message:${id}`, { provider: "codex", native_id: item.id, version: 1,
            role: item.type === "agentMessage" ? "assistant" : "user", body_state: "stored",
            body: item.text ?? item.content, ...(item.phase ? { phase: item.phase } : {}) });
          this.emitFact(thread, "message_membership.created", `message_membership:${JSON.stringify([id, thread.conversationId])}`, {
            message_id: id, conversation_id: thread.conversationId, active: true });
        } else if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && item.status === "completed") {
          for (const child of item.receiverThreadIds) this.relate(thread, "delegated", item.senderThreadId, child, { item_id: item.id });
        }
        break;
      }
    }
  }
}
