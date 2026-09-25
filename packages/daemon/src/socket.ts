import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createMcpSession, type DelegateHandler } from "./mcp/server.ts";

export type Hello = {
  type: "hello";
  traceparent?: string;
  tracestate?: string;
  session?: string;
  client?: "claude" | "codex" | "planner";
  cwd: string;
  pid: number;
};

export function isHello(value: unknown): value is Hello {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hello = value as Record<string, unknown>;
  return hello.type === "hello" && typeof hello.cwd === "string" && Number.isInteger(hello.pid) &&
    (hello.client === undefined || hello.client === "claude" || hello.client === "codex" || hello.client === "planner");
}

// hello を受けた時点で呼ぶ。根の登録と pid の記録に使う。終わるまで MCP の要求は溜めておく。
export type HelloHandler = (hello: Hello) => Promise<void> | void;

function acceptConnection(socket: Socket, handler: DelegateHandler<Hello>, onHello?: HelloHandler,
  onError: (error: unknown) => void = console.error): void {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const readHello = (chunk: Buffer): void => {
    pending += decoder.write(chunk);
    const end = pending.indexOf("\n");
    if (end < 0) return;
    socket.off("data", readHello);
    let hello: unknown;
    try {
      hello = JSON.parse(pending.slice(0, end));
    } catch {
      socket.destroy();
      return;
    }
    if (!isHello(hello)) {
      socket.destroy();
      return;
    }
    let buffered = pending.slice(end + 1);
    const buffer = (chunk: Buffer): void => { buffered += decoder.write(chunk); };
    socket.on("data", buffer);
    const registered = onHello ? Promise.resolve().then(() => onHello(hello)).catch(onError) : Promise.resolve();
    void registered.then(() => {
      socket.off("data", buffer);
      if (socket.destroyed) return;
      const session = createMcpSession(socket, handler, hello);
      if (buffered) session.receive(buffered);
    });
  };
  socket.on("data", readHello);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const entry = await stat(socketPath);
    if (!entry.isSocket()) throw new Error(`Path exists and is not a socket: ${socketPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => { probe.destroy(); reject(new Error(`Socket is already active: ${socketPath}`)); });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
  await unlink(socketPath);
}

export async function startSocketServer(options: { socketPath: string; handler: DelegateHandler<Hello>;
  onHello?: HelloHandler; onError?: (error: unknown) => void }): Promise<Server> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(options.socketPath);
  const server = createServer((socket) => acceptConnection(socket, options.handler, options.onHello, options.onError));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(options.socketPath, 0o600);
  return server;
}
