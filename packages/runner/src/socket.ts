import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import { secureSocketDirectory } from "./paths.ts";
import type { TerminalExit } from "./terminals/index.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 5000;
export const MAX_TERMINAL_OUTPUT_BYTES = 64 * 1024;
export type ClientRole = "api" | "mcp" | "cli";
export interface SocketRequest { type: "req"; cmd_id: string; command: string; payload?: JsonValue }
export type SocketResponse = { type: "res"; cmd_id: string } & (
  | { ok: true; result: JsonValue }
  | { ok: false; error: string }
);
export type RunnerEvent = { type: "evt" } & (
  | { seq: number }
  | { delta: { runId: string; text: string; conversationId?: string; messageId?: string } }
  | { terminal: { terminalId: string } & ({ output: string } | { exit: TerminalExit }) }
);
export interface RunnerSocket {
  publish(event: RunnerEvent): void;
  close(): Promise<void>;
}

export class RunnerProtocol {
  private clients = new Set<Socket>();
  private accepted = new Set<Socket>();
  private terminalClients = new Set<Socket>();
  private terminalOutput = new Map<string, string>();
  private outputFlush?: ReturnType<typeof setImmediate>;
  // 実行中の Promise も保存し、別接続からの同時再送を一度にまとめる。
  private responses = new Map<string, Promise<SocketResponse>>();
  private handle: (request: SocketRequest, role: ClientRole) => Promise<JsonValue> | JsonValue;
  constructor(handle: (request: SocketRequest, role: ClientRole) => Promise<JsonValue> | JsonValue) { this.handle = handle; }
  attach(socket: Socket): void {
    const { clients, accepted, responses, handle } = this;
    clients.add(socket);
    let buffer = "";
    let role: ClientRole | undefined;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { clients.delete(socket); accepted.delete(socket); this.terminalClients.delete(socket); });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { socket.destroy(); return; }
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
        if (!role) {
          if (message.type !== "hello" || message.version !== PROTOCOL_VERSION || !["api", "mcp", "cli"].includes(message.role)) {
            socket.destroy(); return;
          }
          role = message.role as ClientRole;
          accepted.add(socket);
          socket.write(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, role: "runner" }) + "\n");
          continue;
        }
        if (message.type !== "req" || typeof message.cmd_id !== "string" || !message.cmd_id || typeof message.command !== "string") {
          socket.destroy(); return;
        }
        const request = message as SocketRequest;
        // 権限はキャッシュ参照より先に調べ、api の応答を他の role に漏らさない。
        if (request.command.startsWith("terminal.")) {
          if (role !== "api") {
            socket.write(JSON.stringify({ type: "res", cmd_id: request.cmd_id, ok: false, error: "Terminal commands require api role" }) + "\n");
            continue;
          }
          // 旧 api は未知の evt で切断するため、端末を利用した接続だけ購読する。
          this.terminalClients.add(socket);
        }
        const cache = !["terminal.write", "terminal.resize", "terminal.list"].includes(request.command);
        const responseKey = `${role}:${request.cmd_id}`;
        let response = cache ? responses.get(responseKey) : undefined;
        if (!response) {
          const clientRole = role;
          response = Promise.resolve().then(() => handle(request, clientRole)).then(
            (result): SocketResponse => ({ type: "res", cmd_id: request.cmd_id, ok: true, result }),
            (error): SocketResponse => ({ type: "res", cmd_id: request.cmd_id, ok: false, error: error instanceof Error ? error.message : String(error) }),
          );
          if (cache) responses.set(responseKey, response);
        }
        void response.then((result) => { if (!socket.destroyed) socket.write(JSON.stringify(result) + "\n"); });
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    });
  }
  publish(event: RunnerEvent): void {
    if ("terminal" in event) {
      const { terminal } = event;
      if ("output" in terminal) {
        const output = (this.terminalOutput.get(terminal.terminalId) ?? "") + terminal.output;
        if (Buffer.byteLength(output) > MAX_TERMINAL_OUTPUT_BYTES) {
          // 欠けた出力を継続配信せず、再接続時の scrollback で復元する。
          this.terminalOutput.delete(terminal.terminalId);
          for (const socket of this.terminalClients) socket.destroy();
          return;
        }
        if (this.terminalClients.size) this.terminalOutput.set(terminal.terminalId, output);
        this.outputFlush ??= setImmediate(() => this.flushTerminalOutput());
        return;
      }
      this.flushTerminalOutput();
    }
    this.broadcast(event);
  }
  private flushTerminalOutput(): void {
    clearImmediate(this.outputFlush);
    this.outputFlush = undefined;
    for (const [terminalId, output] of this.terminalOutput) this.broadcast({ type: "evt", terminal: { terminalId, output } });
    this.terminalOutput.clear();
  }
  private broadcast(event: RunnerEvent): void {
    const line = JSON.stringify(event) + "\n";
    for (const socket of "terminal" in event ? this.terminalClients : this.accepted) {
      if (socket.destroyed) continue;
      if (socket.writableLength > MAX_FRAME_BYTES) socket.destroy();
      else socket.write(line);
    }
  }
  disconnect(): void {
    clearImmediate(this.outputFlush); this.outputFlush = undefined; this.terminalOutput.clear();
    for (const socket of this.clients) socket.destroy();
  }
}

function listenSocket(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
}

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => socket.destroy(new Error("Runner socket probe timed out")));
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

export async function serveSocket(path: string, handle: (request: SocketRequest, role: ClientRole) => Promise<JsonValue> | JsonValue): Promise<RunnerSocket> {
  secureSocketDirectory(path);
  const protocol = new RunnerProtocol(handle);
  const server = createServer((socket) => protocol.attach(socket));
  try { await listenSocket(server, path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") throw error;
    const stale = lstatSync(path);
    if (await probeSocket(path)) throw error;
    const current = lstatSync(path);
    // 接続拒否でも、本人所有の同じソケット以外は削除しない。
    if (!process.getuid || !current.isSocket() || current.uid !== process.getuid()
      || current.dev !== stale.dev || current.ino !== stale.ino) throw error;
    unlinkSync(path);
    await listenSocket(server, path);
  }
  chmodSync(path, 0o600);
  return {
    publish(event) { protocol.publish(event); },
    close() {
      protocol.disconnect();
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
