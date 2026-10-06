import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { IntakeStatus } from "../../../core/src/intake/index.ts";

export const RECONNECT_INITIAL_MS = 100;
export const RECONNECT_MAX_MS = 5000;
export const UNAVAILABLE_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;
interface RpcMessage { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }
interface Pending { message: RpcMessage; wireId?: string; timer?: NodeJS.Timeout; delegateId?: string; progress: number }
export interface ShimOptions {
  path: string;
  input: Readable;
  output: Writable;
  env?: NodeJS.ProcessEnv;
  connect?: (path: string) => Socket;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  unavailableTimeoutMs?: number;
}

export class McpShim {
  private options: ShimOptions;
  private socket?: Socket;
  private ready = false;
  private closed = false;
  private retry?: NodeJS.Timeout;
  private delay: number;
  private pending = new Set<Pending>();
  private wire = new Map<string, Pending>();
  private accepted = new Map<string, IntakeStatus>();
  private cachedTools: unknown;
  private provider?: "claude" | "codex";
  private inputBuffer = "";
  private receiveInput: (chunk: Buffer | string) => void;
  constructor(options: ShimOptions) {
    this.options = options;
    this.delay = options.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
    options.input.setEncoding("utf8");
    this.receiveInput = (chunk) => this.readInput(chunk.toString());
    options.input.on("data", this.receiveInput);
    options.input.once("end", () => this.close());
    this.connect();
  }
  private output(message: unknown): void { if (!this.closed) this.options.output.write(JSON.stringify(message) + "\n"); }
  private readInput(chunk: string): void {
    this.inputBuffer += chunk;
    while (this.inputBuffer.includes("\n")) {
      const end = this.inputBuffer.indexOf("\n");
      const line = this.inputBuffer.slice(0, end); this.inputBuffer = this.inputBuffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.close(); return; }
      let message;
      try { message = JSON.parse(line); }
      catch { this.output({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
      if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        this.output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }); continue;
      }
      if (message.id !== undefined && message.id !== null && !["string", "number"].includes(typeof message.id)) {
        this.output({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }); continue;
      }
      this.call(message);
    }
    if (Buffer.byteLength(this.inputBuffer) > MAX_FRAME_BYTES) this.close();
  }
  private call(message: RpcMessage): void {
    if (message.method === "initialize") {
      const clientName = (message.params?.clientInfo as { name?: unknown } | undefined)?.name;
      const name = typeof clientName === "string" ? clientName.toLowerCase() : undefined;
      this.provider = name?.includes("claude") ? "claude" : name?.includes("codex") ? "codex" : undefined;
      this.output({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "agent-graph-v2-shim", version: "2.0.0" } } });
      return;
    }
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") {
        for (const pending of this.pending) if (pending.message.id === message.params?.requestId) {
          if (this.ready) this.send({ ...message, params: { ...message.params, requestId: pending.wireId } });
          this.finish(pending);
        }
      }
      return;
    }
    if (message.method === "ping") { this.output({ jsonrpc: "2.0", id: message.id, result: {} }); return; }
    if (message.method === "tools/list" && !this.ready && this.cachedTools !== undefined) {
      this.output({ jsonrpc: "2.0", id: message.id, result: this.cachedTools }); return;
    }
    const pending: Pending = { message, progress: 0 };
    if (message.method === "tools/call" && message.params?.name === "delegate") {
      const requestId = `mcp:${randomUUID()}`;
      const env = this.options.env ?? process.env;
      const origin = env.CLAUDE_CODE_SESSION_ID && (!env.CODEX_THREAD_ID || this.provider === "claude")
        ? { provider: "claude", nativeId: env.CLAUDE_CODE_SESSION_ID }
        : env.CODEX_THREAD_ID && (!env.CLAUDE_CODE_SESSION_ID || this.provider === "codex")
          ? { provider: "codex", nativeId: env.CODEX_THREAD_ID } : undefined;
      pending.delegateId = requestId;
      pending.message = { ...message, params: { ...message.params, arguments: {
        ...(message.params.arguments as object), requestId, source: "mcp",
        parentRun: env.AGENT_GRAPH_MANAGED || undefined, origin: env.AGENT_GRAPH_MANAGED ? undefined : origin,
      } } };
    }
    this.pending.add(pending);
    if (this.ready) this.forward(pending);
    this.arm(pending);
  }
  private arm(pending: Pending): void {
    if (pending.timer || (this.ready && pending.message.params?.name === "wait")) return;
    pending.timer = setTimeout(() => {
      this.output({ jsonrpc: "2.0", id: pending.message.id, ...(pending.message.method === "tools/list" && this.cachedTools !== undefined
        ? { result: this.cachedTools } : { error: { code: -32001, message: "Runner unavailable", data: {
          ...(pending.delegateId ? { requestId: pending.delegateId, acceptance: "unknown" } : {}), retryable: true,
        } } }) });
      this.finish(pending);
    }, this.options.unavailableTimeoutMs ?? UNAVAILABLE_TIMEOUT_MS);
  }
  private finish(pending: Pending): void {
    clearTimeout(pending.timer); this.pending.delete(pending);
    if (pending.wireId) this.wire.delete(pending.wireId);
  }
  private send(message: unknown): void { this.socket?.write(JSON.stringify(message) + "\n"); }
  private forward(pending: Pending): void {
    if (pending.wireId) this.wire.delete(pending.wireId);
    pending.wireId = randomUUID(); this.wire.set(pending.wireId, pending);
    this.send({ ...pending.message, id: pending.wireId });
    if (pending.message.params?.name === "wait") { clearTimeout(pending.timer); pending.timer = undefined; }
  }
  private connect(): void {
    if (this.closed) return;
    const socket = (this.options.connect ?? createConnection)(this.options.path);
    this.socket = socket;
    let buffer = "";
    const handshakeTimer = setTimeout(() => socket.destroy(), this.options.unavailableTimeoutMs ?? UNAVAILABLE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => this.send({ type: "hello", version: 1, role: "mcp" }));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.socket !== socket) return;
      this.ready = false; this.wire.clear();
      for (const pending of this.pending) { pending.wireId = undefined; this.arm(pending); }
      if (!this.closed) {
        this.retry = setTimeout(() => this.connect(), this.delay);
        this.delay = Math.min(this.delay * 2, this.options.reconnectMaxMs ?? RECONNECT_MAX_MS);
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return; }
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!this.ready) {
          if (message?.type !== "hello" || message.version !== 1 || message.role !== "runner") { socket.destroy(); return; }
          clearTimeout(handshakeTimer); this.ready = true; this.delay = this.options.reconnectInitialMs ?? RECONNECT_INITIAL_MS;
          // 確認済みの委譲は submit を再送せず、現在の保存済み状態だけ照合する。
          for (const requestId of this.accepted.keys()) this.send({ jsonrpc: "2.0", id: `reconcile:${requestId}`, method: "tools/call", params: { name: "status", arguments: { requestId } } });
          for (const pending of this.pending) this.forward(pending);
          this.send({ jsonrpc: "2.0", id: "cache:tools", method: "tools/list" });
          continue;
        }
        if (message?.jsonrpc !== "2.0") { socket.destroy(); return; }
        if (message.id === "cache:tools") { if (message.result) this.cachedTools = message.result; continue; }
        if (typeof message.id === "string" && message.id.startsWith("reconcile:")) {
          const status = message.result?.structuredContent as IntakeStatus | undefined;
          if (status) this.accepted.set(status.requestId, status);
          continue;
        }
        if (message.method === "notifications/progress") {
          const waiting = [...this.pending].find((p) => p.message.params?.name === "wait"
            && (p.message.params?._meta as { progressToken?: unknown } | undefined)?.progressToken === message.params?.progressToken);
          if (waiting) this.output({ ...message, params: { ...message.params, progress: waiting.progress++ } });
          continue;
        }
        const pending = this.wire.get(message.id);
        if (!pending) continue;
        if (message.error?.code === -32001) { socket.destroy(); return; }
        if (pending.message.method === "tools/list" && message.result) this.cachedTools = message.result;
        if (pending.delegateId && message.result?.structuredContent) this.accepted.set(pending.delegateId, message.result.structuredContent);
        this.output({ ...message, id: pending.message.id }); this.finish(pending);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.retry); this.socket?.destroy();
    this.options.input.off("data", this.receiveInput);
    for (const pending of this.pending) this.finish(pending);
  }
}

export function startShim(options: ShimOptions): McpShim { return new McpShim(options); }
