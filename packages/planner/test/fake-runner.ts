import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import type { TestContext } from "node:test";

export async function serve(t: TestContext, handle: (frame: any, socket: Socket) => void) {
  const frames: any[] = [];
  const sockets = new Set<Socket>();
  const connectSocket = (_path: string): Socket => {
    let buffer = "";
    const stream = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n");
          const frame = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          frames.push(frame);
          if (frame.type === "hello") stream.push(JSON.stringify({ type: "hello", version: 1, role: "runner" }) + "\n");
          else handle(frame, socket);
        }
        callback();
      },
    });
    // Unix ソケットと同じストリーム境界を使い、待受権限がない環境でも通信を検証する。
    const socket = stream as unknown as Socket;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  return { path: "/fake/runner.sock", frames, connectSocket };
}
export function respond(socket: Socket, frame: any, result: unknown) {
  socket.push(JSON.stringify({ type: "res", cmd_id: frame.cmd_id, ok: true, result }) + "\n");
}
