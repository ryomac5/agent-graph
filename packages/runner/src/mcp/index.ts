import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { IntakeStatus } from "../../../core/src/intake/index.ts";
import { isTerminalState } from "../../../core/src/intake/index.ts";
import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import { Intake, type IntakeOptions } from "../intake/index.ts";
import type { AgentHost } from "../host/contract.ts";
import { ClaudeHost } from "../hosts/claude/index.ts";
import { CodexHost } from "../hosts/codex/index.ts";
import { secureSocketDirectory } from "../paths.ts";
import { RunnerRuntime } from "../runtime.ts";
import { RunnerPlanner } from "../planner.ts";
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, RunnerProtocol, type RunnerEvent } from "../socket.ts";

const SOCKET_PROBE_TIMEOUT_MS = 5000;

export const TOOLS = [
  { name: "delegate", description: "Accept a delegation without waiting for its result. Use agent-graph watch for long tasks.", inputSchema: {
    type: "object", required: ["role", "title", "task", "accept"], properties: {
      requestId: { type: "string" }, role: { type: "string", enum: ["implement", "review", "research", "document", "orchestrate"] },
      title: { type: "string" }, task: { type: "string" }, accept: { type: "array", items: { type: "string" } },
      scope: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
      outputs: { type: "array", items: { type: "string" } }, constraints: { type: "object" }, timeoutSec: { type: "number" }, review: { type: "boolean" },
    },
  } },
  ...["status", "wait"].map((name) => ({ name, description: name === "status" ? "Get current IntakeStatus." : "Wait for a short delegation, with progress notifications.",
    inputSchema: { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } } })),
];

type RpcId = string | number | null;
interface RpcRequest { jsonrpc: "2.0"; id?: RpcId; method: string; params?: Record<string, unknown> }
interface Waiter { socket: Socket; id: RpcId; requestId: string; token?: string | number; progress: number; previous?: string }
function write(socket: Socket, value: unknown): void {
  if (socket.destroyed) return;
  if (socket.writableLength > MAX_FRAME_BYTES) socket.destroy();
  else socket.write(JSON.stringify(value) + "\n");
}
function result(socket: Socket, id: RpcId, value: unknown): void { write(socket, { jsonrpc: "2.0", id, result: value }); }
function toolResult(status: IntakeStatus) {
  return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
}

export class McpProtocol {
  private clients = new Set<Socket>();
  private waiters = new Set<Waiter>();
  private intake: Pick<Intake, "submit" | "status">;
  private fallback?: RunnerProtocol;
  constructor(intake: Pick<Intake, "submit" | "status">, fallback?: RunnerProtocol) { this.intake = intake; this.fallback = fallback; }
  attach(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";
    let ready = false;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.clients.delete(socket);
      for (const waiter of this.waiters) if (waiter.socket === socket) this.waiters.delete(waiter);
    });
    const receive = (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return; }
        let message;
        try { message = JSON.parse(line); }
        catch { write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
        if (!ready) {
          if (message?.type !== "hello" || message.version !== PROTOCOL_VERSION) { socket.destroy(); return; }
          if (["api", "cli"].includes(message.role) && this.fallback) {
            socket.off("data", receive);
            this.fallback.attach(socket);
            socket.emit("data", line + "\n" + buffer);
            return;
          }
          if (message.role !== "mcp") { socket.destroy(); return; }
          ready = true;
          write(socket, { type: "hello", version: PROTOCOL_VERSION, role: "runner" });
          continue;
        }
        this.dispatch(socket, message);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    };
    socket.on("data", receive);
  }
  private dispatch(socket: Socket, message: RpcRequest): void {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string"
      || (message.id !== undefined && message.id !== null && !["string", "number"].includes(typeof message.id))) {
      write(socket, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }); return;
    }
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") for (const waiter of this.waiters) {
        if (waiter.socket === socket && waiter.id === message.params?.requestId) this.waiters.delete(waiter);
      }
      return;
    }
    const { id, method, params = {} } = message;
    try {
      if (method === "initialize") {
        result(socket, id, { protocolVersion: params.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-graph-v2", version: "2.0.0" } });
      } else if (method === "ping") result(socket, id, {});
      else if (method === "tools/list") result(socket, id, { tools: TOOLS });
      else if (method === "tools/call") {
        const args = params.arguments as Record<string, unknown> | undefined;
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Invalid tool arguments");
        if (params.name === "delegate") {
          const status = this.intake.submit({ ...args, source: "mcp" });
          result(socket, id, toolResult(status));
        } else if (params.name === "status" || params.name === "wait") {
          if (typeof args.requestId !== "string" || !args.requestId) throw new TypeError("Invalid requestId");
          if (params.name === "status") result(socket, id, toolResult(this.intake.status(args.requestId)));
          else {
            const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken;
            const waiter: Waiter = { socket, id, requestId: args.requestId, progress: 0,
              ...(typeof token === "string" || typeof token === "number" ? { token } : {}) };
            this.waiters.add(waiter);
            this.refresh(waiter);
          }
        } else throw new TypeError("Unknown tool");
      } else write(socket, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      write(socket, { jsonrpc: "2.0", id, error: { code: reason === "Runner is recovering" ? -32001 : -32602, message: reason } });
    }
  }
  private refresh(waiter: Waiter): void {
    try {
      const status = this.intake.status(waiter.requestId);
      const current = JSON.stringify(status);
      if (waiter.previous !== current) {
        waiter.previous = current;
        if (waiter.token !== undefined) write(waiter.socket, { jsonrpc: "2.0", method: "notifications/progress", params: {
          progressToken: waiter.token, progress: waiter.progress++, message: current,
        } });
      }
      if (isTerminalState(status.state)) { this.waiters.delete(waiter); result(waiter.socket, waiter.id, toolResult(status)); }
    } catch (error) {
      this.waiters.delete(waiter);
      const reason = error instanceof Error ? error.message : String(error);
      write(waiter.socket, { jsonrpc: "2.0", id: waiter.id, error: { code: reason === "Runner is recovering" ? -32001 : -32602, message: reason } });
    }
  }
  publish(_event?: RunnerEvent): void { for (const waiter of this.waiters) this.refresh(waiter); }
  disconnect(): void { for (const socket of this.clients) socket.destroy(); }
}

async function listen(server: Server, path: string): Promise<void> {
  const bind = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  try { await bind(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const stale = lstatSync(path);
    const active = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(path);
      probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => probe.destroy(new Error("Runner socket probe timed out")));
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", (failure: NodeJS.ErrnoException) => {
        probe.destroy(); if (failure.code === "ECONNREFUSED") resolve(false); else reject(failure);
      });
    });
    if (active) throw error;
    const current = lstatSync(path);
    // 本人所有で接続を拒否した同じソケットだけを復旧のために置き換える。
    if (!process.getuid || !current.isSocket() || current.uid !== process.getuid()
      || current.dev !== stale.dev || current.ino !== stale.ino) throw error;
    unlinkSync(path); await bind();
  }
}

export async function serveMcpRunner(ledger: Ledger, path: string,
  options: IntakeOptions & { hosts?: readonly AgentHost[]; isolation?: "shared" | "worktree" } = {}) {
  let ready = false;
  const planner = new RunnerPlanner(path);
  const fallback = new RunnerProtocol((request) => {
    if (!ready) throw new Error("Runner is recovering");
    if (request.command === "planner.run" || request.command === "planner.status") return planner.command(request);
    return intake.command(request);
  });
  const protocol = new McpProtocol({
    submit(value) { if (!ready) throw new Error("Runner is recovering"); return intake.submit(value); },
    status(id) { if (!ready) throw new Error("Runner is recovering"); return intake.status(id); },
  }, fallback);
  const publish = (event: RunnerEvent) => { fallback.publish(event); protocol.publish(event); options.publish?.(event); };
  const runtime = new RunnerRuntime(ledger, options.hosts ?? [new ClaudeHost(), new CodexHost()], publish, options.isolation);
  const intake = new Intake(ledger, runtime, { ...options, publish });
  secureSocketDirectory(path);
  const server = createServer((socket) => protocol.attach(socket));
  try {
    await listen(server, path);
    chmodSync(path, 0o600);
    await runtime.recover(); await intake.recover(); ready = true;
  } catch (error) { protocol.disconnect(); await intake.close(); if (server.listening) server.close(); throw error; }
  const reconcile = setInterval(() => intake.reconcileOrigins(), 500);
  reconcile.unref();
  return { intake, runtime, protocol, async close() {
    ready = false; clearInterval(reconcile); protocol.disconnect(); fallback.disconnect();
    try { await planner.close(); } finally {
      try { await intake.close(); } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    }
  } };
}
