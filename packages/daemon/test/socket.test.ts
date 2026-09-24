import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startSocketServer } from "../src/socket.ts";

test("socket is private and shim forwards hello", async (t) => {
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
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const child = spawn(process.execPath, ["src/shim.ts"], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, AGENT_GRAPH_SOCKET: socketPath, TRACEPARENT: traceparent },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delegate","arguments":{"role":"implement","title":"X","task":"Y","accept":["true"]}}}\n');
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", () => { if (output.includes("\n")) resolve(); });
      child.once("error", reject);
      child.once("exit", (code) => { if (!output.includes("\n")) reject(new Error(`shim exited ${code}: ${stderr}`)); });
    });
    const result = JSON.parse(output.trim()) as { result: { structuredContent: { traceparent: string; cwd: string } } };
    assert.equal(result.result.structuredContent.traceparent, traceparent);
    assert.equal(result.result.structuredContent.cwd, join(import.meta.dirname, ".."));
    child.kill();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
