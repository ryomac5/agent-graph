import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { ledgerDbPath } from "./paths.ts";
import type { JsonValue } from "../../core/src/ledger/facts.ts";

// runner の内部には依存せず、ソケットの版とフレームだけを共有する。
export const RUNNER_PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const RECONNECT_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
export interface RunnerRequest { type: "req"; cmd_id: string; command: string; payload?: JsonValue }
export type RunnerResponse = { type: "res"; cmd_id: string } & (
  | { ok: true; result: JsonValue } | { ok: false; error: string }
);
export type RunnerEvent = { type: "evt"; seq: number } | {
  type: "evt"; delta: { runId: string; text: string; conversationId?: string; messageId?: string };
};
export function runnerSocketPath(): string { return join(dirname(ledgerDbPath()), "runner.sock"); }

export class RunnerClient {
  private socket?: Socket;
  private ready = false;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, {
    request: RunnerRequest; promise: Promise<RunnerResponse>; resolve: (response: RunnerResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private path: string;
  private onEvent: (event: RunnerEvent) => void;
  constructor(path: string, onEvent: (event: RunnerEvent) => void) {
    this.path = path;
    this.onEvent = onEvent;
    this.connect();
  }
  get available(): boolean { return this.ready; }
  request(request: RunnerRequest): Promise<RunnerResponse> {
    const existing = this.pending.get(request.cmd_id);
    if (existing) return existing.promise;
    if (!this.ready) return Promise.resolve({ type: "res", cmd_id: request.cmd_id, ok: false, error: "Runner unavailable" });
    let resolve!: (response: RunnerResponse) => void;
    const promise = new Promise<RunnerResponse>((done) => { resolve = done; });
    const timer = setTimeout(() => this.complete({ type: "res", cmd_id: request.cmd_id, ok: false,
      error: "Runner response timed out; retry with the same cmd_id" }), REQUEST_TIMEOUT_MS);
    this.pending.set(request.cmd_id, { request, promise, resolve, timer });
    this.send(request);
    return promise;
  }
  private complete(response: RunnerResponse): void {
    const pending = this.pending.get(response.cmd_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.cmd_id);
    pending.resolve(response);
  }
  private send(request: RunnerRequest): void { this.socket?.write(JSON.stringify(request) + "\n"); }
  private connect(): void {
    if (this.stopped) return;
    const socket = createConnection(this.path);
    this.socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    const handshake = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    socket.on("error", () => socket.destroy());
    socket.on("connect", () => socket.write(JSON.stringify({ type: "hello", version: RUNNER_PROTOCOL_VERSION, role: "api" }) + "\n"));
    socket.on("close", () => {
      clearTimeout(handshake);
      this.ready = false;
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), RECONNECT_MS);
    });
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
        if (!this.ready) {
          if (message.type !== "hello" || message.version !== RUNNER_PROTOCOL_VERSION || message.role !== "runner") {
            socket.destroy(); return;
          }
          clearTimeout(handshake);
          this.ready = true;
          for (const pending of this.pending.values()) this.send(pending.request);
        } else if (message.type === "res" && typeof message.cmd_id === "string" && typeof message.ok === "boolean"
          && (message.ok ? "result" in message : typeof message.error === "string")) {
          this.complete(message as RunnerResponse);
        } else if (message.type === "evt" && (Number.isSafeInteger(message.seq) && message.seq >= 0
          || message.delta && typeof message.delta.runId === "string" && typeof message.delta.text === "string")) {
          this.onEvent(message as RunnerEvent);
        } else { socket.destroy(); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) socket.destroy();
    });
  }
  close(): void {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.ready = false;
    this.socket?.destroy();
    for (const cmd_id of this.pending.keys()) this.complete({ type: "res", cmd_id, ok: false, error: "Runner unavailable" });
  }
}
