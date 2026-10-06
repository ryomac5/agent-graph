import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import { secureSocketDirectory } from "./paths.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 5000;
export type ClientRole = "api" | "mcp" | "cli";
export interface SocketRequest { type: "req"; cmd_id: string; command: string; payload?: JsonValue }
export type SocketResponse = { type: "res"; cmd_id: string } & (
  | { ok: true; result: JsonValue }
  | { ok: false; error: string }
);
export type RunnerEvent = { type: "evt" } & (
  | { seq: number }
  | { delta: { runId: string; text: string; conversationId?: string; messageId?: string } }
);
export interface RunnerSocket {
  publish(event: RunnerEvent): void;
  close(): Promise<void>;
}

export class RunnerProtocol {
  private clients = new Set<Socket>();
  private accepted = new Set<Socket>();
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
    socket.on("close", () => { clients.delete(socket); accepted.delete(socket); });
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
        let response = responses.get(request.cmd_id);
        if (!response) {
          const clientRole = role;
          response = Promise.resolve().then(() => handle(request, clientRole)).then(
            (result): SocketResponse => ({ type: "res", cmd_id: request.cmd_id, ok: true, result }),
            (error): SocketResponse => ({ type: "res", cmd_id: request.cmd_id, ok: false, error: error instanceof Error ? error.message : String(error) }),
          );
          responses.set(request.cmd_id, response);
        }
        void response.then((result) => { if (!socket.destroyed) socket.write(JSON.stringify(result) + "\n"); });
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    });
  }
  publish(event: RunnerEvent): void {
    const line = JSON.stringify(event) + "\n";
    for (const socket of this.accepted) {
      if (socket.destroyed) continue;
      if (socket.writableLength > MAX_FRAME_BYTES) socket.destroy();
      else socket.write(line);
    }
  }
  disconnect(): void { for (const socket of this.clients) socket.destroy(); }
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
