import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { query, type AccountInfo, type CanUseTool, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "../../../../core/src/ledger/facts.ts";
import type { AgentHost, ApprovalId, Decision, ForkRequest, HostCapabilities, HostEvent, HostFact, HostLaunchOptions, IntegrationMode, ModelChoice, ModelInfo, ResumeRequest, RunHandle, StartRequest, UserInput } from "../../host/contract.ts";
import { AsyncQueue } from "./queue.ts";

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "setModel" | "close" | "accountInfo" | "supportedModels">;
export type QueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ClaudeQuery;
export interface ClaudeCapabilities extends HostCapabilities {
  authentication: { type: "unknown" | "subscription" | "api_key"; verified: boolean; subscriptionType?: string; apiProvider?: string };
}
export interface ClaudeHostOptions extends HostLaunchOptions { enableFork?: boolean; integrationMode?: IntegrationMode }
interface OpenRun {
  request: StartRequest;
  integrationMode: IntegrationMode;
  sessionId: string;
  input: AsyncQueue<SDKUserMessage>;
  events: AsyncQueue<HostEvent>;
  query: ClaudeQuery;
  reader: Promise<void>;
  closed: boolean;
  finished: boolean;
  sawState: boolean;
  firstResult: boolean;
  turns: string[];
  interrupted: Set<string>;
  tasks: Set<string>;
  activeTasks: Set<string>;
  childConversations: Map<string, string>;
  process: { pid?: number; exitCode?: number | null; signal?: string | null };
  lastInterrupted: boolean;
}
interface PendingApproval {
  run: OpenRun;
  resolve: (result: PermissionResult) => void;
  input: Record<string, unknown>;
  cleanup: () => void;
}
function toJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function getEffort(model: ModelChoice): Options["effort"] {
  if (model.effort === undefined) return undefined;
  if (!["low", "medium", "high", "xhigh", "max"].includes(model.effort)) throw new Error("Unsupported Claude effort");
  return model.effort as Options["effort"];
}

export class ClaudeHost implements AgentHost {
  readonly provider = "claude" as const;
  private factory: QueryFactory;
  private runs = new Map<string, OpenRun>();
  private approvals = new Map<ApprovalId, PendingApproval>();
  private degraded = new Set<string>();
  private authentication: ClaudeCapabilities["authentication"] = { type: "unknown", verified: false };
  private epoch = randomUUID();
  private sequence = 0;
  private timestamp = 0;
  private options: ClaudeHostOptions;
  private models?: ModelInfo[];
  private modelDiscovery?: Promise<ModelInfo[]>;
  constructor(factory: QueryFactory = query, options: ClaudeHostOptions = {}) { this.factory = factory; this.options = options; }
  capabilities(): ClaudeCapabilities {
    return { start: true, resume: this.options.persistSession !== false, fork: this.options.persistSession !== false && (this.options.enableFork ?? false), interrupt: true, approvals: true, setModel: true, delta: true,
      authentication: { ...this.authentication }, degraded: [...this.degraded] };
  }
  start(req: StartRequest): Promise<RunHandle> { return this.open(req, randomUUID()); }
  resume(req: ResumeRequest): Promise<RunHandle> { return this.open(req, req.nativeId, true); }
  async fork(req: ForkRequest): Promise<RunHandle> {
    if (!this.options.enableFork) throw new Error("Claude fork is not supported");
    return this.open(req, randomUUID(), false, req.nativeId);
  }
  private async open(req: StartRequest, sessionId: string, resume = false, forkFrom?: string): Promise<RunHandle> {
    if (this.options.persistSession === false && (resume || forkFrom)) throw new Error("Non-persistent Claude sessions cannot be resumed or forked");
    if (this.runs.has(req.runId)) throw new Error("Run already exists");
    if ([...this.runs.values()].some((run) => !run.finished && run.request.conversationId === req.conversationId)) throw new Error("Conversation is already open");
    const effort = getEffort(req.model);
    const input = new AsyncQueue<SDKUserMessage>();
    const events = new AsyncQueue<HostEvent>();
    const childProcess: OpenRun["process"] = {};
    // 管理する実行の既定は disabled。claude.ai の外部連携を読み込まず、プラグインの MCP は残す。
    const integrationMode = req.integrationMode ?? this.options.integrationMode ?? "disabled";
    let run: OpenRun;
    const sdkQuery = this.createQuery(input, {
      cwd: req.cwd, model: req.model.model, effort,
      ...(forkFrom ? { sessionId, resume: forkFrom, forkSession: true } : resume ? { resume: sessionId } : { sessionId }),
      ...(req.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: req.outputSchema } } : {}),
      env: { ...req.env,
        AGENT_GRAPH_RUN_ID: req.runId, AGENT_GRAPH_CONVERSATION_ID: req.conversationId, AGENT_GRAPH_GENERATION: String(req.generation) },
      canUseTool: (name, toolInput, options) => this.requestApproval(run, name, toolInput, options),
    }, integrationMode, childProcess);
    run = { request: req, integrationMode, sessionId, input, events, query: sdkQuery, reader: Promise.resolve(), closed: false,
      finished: false, sawState: false, firstResult: true, turns: [], interrupted: new Set(), tasks: new Set(), activeTasks: new Set(),
      childConversations: new Map(), process: childProcess, lastInterrupted: false };
    this.runs.set(req.runId, run);
    run.reader = this.consume(run);
    try {
      await this.send(req.runId, req.input);
      this.recordAuthentication(await sdkQuery.accountInfo());
    } catch (error) {
      await this.close(req.runId);
      throw error;
    }
    return { runId: req.runId, nativeId: sessionId, pid: childProcess.pid, events };
  }
  private createQuery(input: AsyncQueue<SDKUserMessage>, options: Options, integrationMode: IntegrationMode, childProcess: OpenRun["process"] = {}): ClaudeQuery {
    return this.factory({ prompt: input, options: {
      settingSources: ["user", "project"], permissionMode: "default", includePartialMessages: true, persistSession: this.options.persistSession ?? true,
      ...options,
      ...(integrationMode === "strict" ? { strictMcpConfig: true, mcpServers: {} } : {}),
      env: { ...process.env, ...options.env, ...(integrationMode === "enabled" ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: "false" }),
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1", AGENT_GRAPH_MANAGED: "1" },
      spawnClaudeCodeProcess(options) {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] });
        childProcess.pid = child.pid;
        // stderr の書き込みで子が止まらないよう、保存せず読み続ける。
        child.stderr.resume();
        child.once("close", (code, signal) => { childProcess.exitCode = code; childProcess.signal = signal; });
        return child;
      },
    } });
  }
  private recordAuthentication(account: AccountInfo): void {
    this.authentication = {
      type: account.subscriptionType && account.apiProvider ? "subscription"
        : account.apiKeySource && account.apiKeySource !== "none" ? "api_key" : "unknown",
      verified: this.authentication.verified,
      subscriptionType: account.subscriptionType, apiProvider: account.apiProvider,
    };
    if (this.authentication.type === "unknown") this.degraded.add("authentication_required");
    else this.degraded.delete("authentication_required");
  }
  private getRun(id: string): OpenRun {
    const run = this.runs.get(id);
    if (!run || run.finished || run.closed) throw new Error("Run is not open");
    return run;
  }
  private emitFact(run: OpenRun, fact: Omit<HostFact, "source_event_id" | "source_ts" | "confidence">): void {
    this.timestamp = Math.max(Date.now(), this.timestamp + 1);
    run.events.push({ type: "fact", fact: { ...fact, source_event_id: `${this.epoch}:${String(++this.sequence).padStart(12, "0")}`,
      source_ts: new Date(this.timestamp).toISOString(), confidence: "confirmed" } as HostFact });
  }
  async send(id: string, input: UserInput): Promise<void> {
    const run = this.getRun(id);
    if (input.attachments?.length) throw new Error("Claude attachments are not supported");
    const uuid = randomUUID();
    run.lastInterrupted = false;
    run.turns.push(uuid);
    run.input.push({ type: "user", uuid, session_id: run.sessionId, parent_tool_use_id: null, message: { role: "user", content: input.text } });
    if (!run.sawState) run.events.push({ type: "state", state: "running" });
  }
  async interrupt(id: string): Promise<void> {
    const run = this.getRun(id);
    const turnId = run.turns[0];
    if (!turnId) throw new Error("No active turn to interrupt");
    run.interrupted.add(turnId);
    this.emitFact(run, { kind: "run.interrupt_requested", subject: `run:${id}`, payload: { turn_id: turnId } });
    this.expireApprovals(run, "interrupt");
    await run.query.interrupt();
  }
  async setModel(id: string, model: ModelChoice): Promise<void> {
    const run = this.getRun(id);
    if (model.effort !== run.request.model.effort) throw new Error("Live Claude effort changes are not supported");
    await run.query.setModel(model.model);
    run.request = { ...run.request, model: { ...model } };
  }
  async listModels(): Promise<ModelInfo[]> {
    const run = [...this.runs.values()].find((run) => !run.closed && !run.finished);
    if (run) {
      this.models = await this.readModels(run.query);
      return this.models;
    }
    if (this.models) return this.models;
    this.modelDiscovery ??= this.discoverModels()
      .then((models) => { this.models = models; return models; })
      .finally(() => { this.modelDiscovery = undefined; });
    return this.modelDiscovery;
  }
  private async readModels(sdkQuery: ClaudeQuery): Promise<ModelInfo[]> {
    return (await sdkQuery.supportedModels()).map((model) => ({ model: model.value, displayName: model.displayName }));
  }
  private async discoverModels(): Promise<ModelInfo[]> {
    const input = new AsyncQueue<SDKUserMessage>();
    let sdkQuery: ClaudeQuery | undefined;
    try {
      try {
        sdkQuery = this.createQuery(input, {
          persistSession: false,
          canUseTool: async () => ({ behavior: "deny", message: "Model discovery does not allow tool execution." }),
        }, this.options.integrationMode ?? "disabled");
        return await this.readModels(sdkQuery);
      } finally {
        input.end();
        sdkQuery?.close();
      }
    } catch (error) {
      throw new Error(`Failed to list Claude models: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  private requestApproval(run: OpenRun, name: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    // 購読の外部連携は読まれる前提で拒否し、受け箱には出さない。
    if (options.mcpServer?.source === "claudeai") return Promise.resolve({ behavior: "deny", message: "External integrations are disabled for managed conversations." });
    if (run.closed || run.finished || options.signal.aborted) return Promise.resolve({ behavior: "deny", message: "Approval expired." });
    const id = `${run.request.runId}:${options.requestId || options.toolUseID}:${randomUUID()}`;
    return new Promise((resolve) => {
      const abort = () => this.resolveApproval(id, { behavior: "deny", message: "Approval expired." }, "expired");
      this.approvals.set(id, { run, resolve, input, cleanup: () => options.signal.removeEventListener("abort", abort) });
      options.signal.addEventListener("abort", abort, { once: true });
      this.emitFact(run, { kind: "approval.created", subject: `approval:${id}`, payload: {
        run_id: run.request.runId, conversation_id: run.request.conversationId, request_id: options.requestId || options.toolUseID,
        state: "pending", available_decisions: ["allow", "deny"], request: toJson({ name, input, tool_use_id: options.toolUseID }) } });
      run.events.push({ type: "state", state: "waiting_approval" });
    });
  }
  async answer(id: ApprovalId, decision: Decision): Promise<void> {
    const pending = this.approvals.get(id);
    if (!pending) throw new Error("Unknown or expired approval");
    const value = typeof decision === "string" ? decision : decision.decision;
    const updatedInput = typeof decision === "string" ? undefined : decision.updatedInput;
    if (updatedInput !== undefined && (updatedInput === null || typeof updatedInput !== "object" || Array.isArray(updatedInput))) throw new Error("Updated tool input must be an object");
    const allow = value === "allow";
    this.emitFact(pending.run, { kind: "approval.answered", subject: `approval:${id}`, payload: { decision: value } });
    this.resolveApproval(id, allow ? { behavior: "allow", updatedInput: updatedInput as Record<string, unknown> | undefined ?? pending.input }
      : { behavior: "deny", message: value === "deny" ? "The user denied this tool request." : value }, "resolved");
    if (!pending.run.sawState) pending.run.events.push({ type: "state", state: "running" });
  }
  private resolveApproval(id: string, result: PermissionResult, state: string, reason?: string): void {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    pending.cleanup();
    this.emitFact(pending.run, { kind: "approval.resolved", subject: `approval:${id}`, payload: { state, reason } });
    pending.resolve(result);
  }
  private expireApprovals(run: OpenRun, reason: string): void {
    for (const [id, pending] of this.approvals) if (pending.run === run) this.resolveApproval(id, { behavior: "deny", message: `Approval expired: ${reason}` }, "expired", reason);
  }
  private async consume(run: OpenRun): Promise<void> {
    try {
      for await (const message of run.query) {
        if (run.finished) break;
        this.mapMessage(run, message);
      }
      if (!run.finished) this.finish(run, run.closed || this.wasInterrupted(run) ? 0 : 1, run.closed || this.wasInterrupted(run) ? undefined : "Claude stream ended unexpectedly");
    } catch (error) {
      if (!run.finished) this.finish(run, run.closed || this.wasInterrupted(run) ? 0 : 1, error instanceof Error ? error.message : String(error));
    }
  }
  private wasInterrupted(run: OpenRun): boolean { return run.lastInterrupted || run.interrupted.size > 0; }
  private mapMessage(run: OpenRun, message: SDKMessage): void {
    const runSubject = `run:${run.request.runId}` as const;
    if (message.type === "system" && message.subtype === "init") {
      if (message.session_id !== run.sessionId) throw new Error("Claude init session_id does not match the requested sessionId");
      this.emitFact(run, { kind: "run.updated", subject: runSubject, payload: { last_evidence: toJson({ kind: "init", integration_mode: run.integrationMode, mcp_servers: message.mcp_servers }) } });
    } else if (message.type === "system" && message.subtype === "session_state_changed") {
      run.sawState = true;
      this.degraded.delete("session_state_events_unavailable");
      const state = message.state === "requires_action" ? "waiting_approval" : message.state;
      if (state === "idle" || state === "running" || state === "waiting_approval") run.events.push({ type: "state", state });
    } else if (message.type === "stream_event") {
      const conversationId = message.parent_tool_use_id ? run.childConversations.get(message.parent_tool_use_id) : run.request.conversationId;
      if (conversationId && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") run.events.push({ type: "delta", text: message.event.delta.text, conversationId });
    } else if (message.type === "assistant") {
      const conversationId = message.parent_tool_use_id ? run.childConversations.get(message.parent_tool_use_id) : run.request.conversationId;
      if (!conversationId) return;
      const id = `${run.sessionId}:${message.uuid}`;
      this.emitFact(run, { kind: "message.created", subject: `message:${id}`, payload: { provider: "claude", native_id: message.uuid, version: 1, role: "assistant", body: toJson(message.message.content), body_state: "stored" } });
      this.emitFact(run, { kind: "message_membership.created", subject: `message_membership:${id}`, payload: { message_id: id, conversation_id: conversationId, active: true } });
    } else if (message.type === "result") {
      const turnId = message.user_message_uuid ?? run.turns[0] ?? message.uuid;
      const interrupted = run.interrupted.has(turnId) || (message.user_message_uuids ?? []).some((id) => run.interrupted.has(id));
      run.lastInterrupted = interrupted;
      const consumed = new Set(message.user_message_uuids ?? [turnId]);
      run.turns = run.turns.filter((id) => !consumed.has(id));
      for (const id of consumed) run.interrupted.delete(id);
      if (run.firstResult && !run.sawState) this.degraded.add("session_state_events_unavailable");
      const body = "result" in message ? message.result : message.errors.join("\n");
      if (/Not logged in/i.test(body)) this.degraded.add("authentication_required");
      if (run.firstResult) this.authentication.verified = !message.is_error && !/Not logged in/i.test(body);
      run.firstResult = false;
      // 形式を縛ったターンの返答は StructuredOutput の道具の入力に入り、本文の発言に残らない。検証済みの値を最終の返答として出す。
      if (!message.is_error && "structured_output" in message && message.structured_output !== undefined) {
        const id = `${run.sessionId}:${message.uuid}`;
        this.emitFact(run, { kind: "message.created", subject: `message:${id}`, payload: { provider: "claude", native_id: message.uuid, version: 1,
          role: "assistant", phase: "final_answer", body: JSON.stringify(message.structured_output), body_state: "stored" } });
        this.emitFact(run, { kind: "message_membership.created", subject: `message_membership:${id}`, payload: { message_id: id, conversation_id: run.request.conversationId, active: true } });
      }
      this.emitFact(run, { kind: "run.updated", subject: runSubject, payload: { last_evidence: toJson({ kind: "result", turn_id: turnId,
        outcome: interrupted ? "interrupted" : message.is_error ? "failed" : "completed", usage: message.usage, model_usage: message.modelUsage,
        total_cost_usd: message.total_cost_usd, cost_is_estimate: true }) } });
      if (message.is_error && !interrupted) this.finish(run, 1, body, turnId);
      else if (interrupted || !run.sawState) run.events.push({ type: "state", state: "idle", ...(interrupted ? { reason: "interrupted" } : {}) });
    } else if (message.type === "system" && message.subtype === "task_started") {
      if (message.task_type && message.task_type !== "local_agent") return;
      this.createSubagent(run, message.task_id, message);
    } else if (message.type === "system" && message.subtype === "task_notification") {
      if (!run.activeTasks.delete(message.task_id)) return;
      this.emitFact(run, { kind: "conversation.updated", subject: `conversation:${run.sessionId}:agent:${message.task_id}`, payload: { type: "subagent" } });
      this.emitFact(run, { kind: "delegation.state_changed", subject: `delegation:${run.sessionId}:${message.task_id}`, payload: {
        state: message.status === "completed" ? "done" : message.status === "stopped" ? "interrupted" : "failed", attempt: 1, result: toJson(message) } });
    }
  }
  private createSubagent(run: OpenRun, taskId: string, message: Extract<SDKMessage, { subtype: "task_started" }>): void {
    if (run.tasks.has(taskId)) return;
    run.tasks.add(taskId);
    run.activeTasks.add(taskId);
    const child = `${run.sessionId}:agent:${taskId}`;
    if (message.tool_use_id) run.childConversations.set(message.tool_use_id, child);
    this.emitFact(run, { kind: "conversation.created", subject: `conversation:${child}`, payload: { provider: "claude", native_id: child, origin: "managed", type: "subagent", history_format: "jsonl" } });
    this.emitFact(run, { kind: "relation.created", subject: `relation:${run.sessionId}:${taskId}`, payload: {
      type: "delegated", from_id: run.request.conversationId, to_id: child, evidence: toJson(message), confidence: "confirmed", active: true } });
    this.emitFact(run, { kind: "delegation.created", subject: `delegation:${run.sessionId}:${taskId}`, payload: {
      request_id: message.tool_use_id ?? taskId, parent_run_id: run.request.runId, role: message.subagent_type ?? "subagent", title: message.description, attempt: 1, state: "running" } });
  }
  private finish(run: OpenRun, exitCode: number, cause?: string, turnId?: string): void {
    this.expireApprovals(run, "close");
    for (const taskId of run.activeTasks) {
      this.emitFact(run, { kind: "delegation.state_changed", subject: `delegation:${run.sessionId}:${taskId}`, payload: {
        state: "interrupted", attempt: 1, result: { reason: "query_closed" } } });
    }
    run.activeTasks.clear();
    this.emitFact(run, { kind: "run.updated", subject: `run:${run.request.runId}`, payload: { last_evidence: toJson({
      kind: "query_closed", ...run.process, interrupted: this.wasInterrupted(run), cause }) } });
    run.finished = true;
    run.input.end();
    run.events.push({ type: "exit", exitCode, cause, turnId });
    run.events.end();
    run.query.close();
    this.runs.delete(run.request.runId);
  }
  async close(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    if (!run.finished) {
      run.closed = true;
      this.expireApprovals(run, "close");
      run.input.end();
      run.query.close();
    }
    await run.reader;
  }
}
