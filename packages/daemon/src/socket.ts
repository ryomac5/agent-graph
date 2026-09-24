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
  cwd: string;
  pid: number;
};

function acceptConnection(socket: Socket, handler: DelegateHandler<Hello>): void {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const readHello = (chunk: Buffer): void => {
    pending += decoder.write(chunk);
    const end = pending.indexOf("\n");
    if (end < 0) return;
    socket.off("data", readHello);
    let hello: Hello;
    try {
      hello = JSON.parse(pending.slice(0, end)) as Hello;
    } catch {
      socket.destroy();
      return;
    }
    if (hello.type !== "hello" || typeof hello.cwd !== "string" || !Number.isInteger(hello.pid)) {
      socket.destroy();
      return;
    }
    const rest = pending.slice(end + 1);
    const session = createMcpSession(socket, handler, hello);
    if (rest) session.receive(rest);
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

export async function startSocketServer(options: { socketPath: string; handler: DelegateHandler<Hello> }): Promise<Server> {
  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(options.socketPath);
  const server = createServer((socket) => acceptConnection(socket, options.handler));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.off("error", reject); resolve(); });
  });
  await chmod(options.socketPath, 0o600);
  return server;
}
