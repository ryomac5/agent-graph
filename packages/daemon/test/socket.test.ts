import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import test from "node:test";
import { isHello, startSocketServer } from "../src/socket.ts";

test("hello は planner を含む既知の client だけを受け付ける", () => {
  const hello = { type: "hello", cwd: "/repo", pid: 123 };
  for (const client of [undefined, "claude", "codex", "planner"]) {
    assert.equal(isHello({ ...hello, client }), true);
  }
  for (const value of [null, [], {}, { ...hello, client: "unknown" }, { ...hello, pid: "123" }]) {
    assert.equal(isHello(value), false);
  }
});

for (const client of ["claude", "codex", "planner"]) test(`socket is private and shim forwards ${client} hello`, { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "agent-graph-test-"));
  const socketPath = join(dir, "daemon.sock");
  let server;
  try {
    server = await startSocketServer({ socketPath, handler: async (_request, context) => context });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Unix socket listen is prohibited by the sandbox");
      return;
    }
    throw error;
  }
  let child: ChildProcess | undefined;
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const shim = spawn(process.execPath, ["src/shim.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, AGENT_GRAPH_SOCKET: socketPath, AGENT_GRAPH_CLIENT: client, TRACEPARENT: traceparent },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child = shim;
    let output = "";
    let stderr = "";
    shim.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    shim.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    shim.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delegate","arguments":{"role":"implement","title":"X","task":"Y","accept":["true"]}}}\n');
    await new Promise<void>((resolve, reject) => {
      t.signal.addEventListener("abort", () => reject(new Error("shim response timed out")), { once: true });
      shim.stdout.on("data", () => { if (output.includes("\n")) resolve(); });
      shim.once("error", reject);
      shim.once("exit", (code) => { if (!output.includes("\n")) reject(new Error(`shim exited ${code}: ${stderr}`)); });
    });
    const result = JSON.parse(output.trim()) as { result: { structuredContent: { traceparent: string; cwd: string; client: string } } };
    assert.equal(result.result.structuredContent.traceparent, traceparent);
    assert.equal(result.result.structuredContent.client, client);
    assert.equal(result.result.structuredContent.cwd, join(import.meta.dirname, ".."));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child!.once("close", () => resolve()));
      child.stdin?.end();
      const timer = setTimeout(() => child!.kill("SIGKILL"), 500);
      await exited;
      clearTimeout(timer);
    }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
