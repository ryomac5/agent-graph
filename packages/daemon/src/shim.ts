#!/usr/bin/env node
import { createConnection } from "node:net";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { runDir } from "./paths.ts";

function detectClient(): "claude" | "codex" | undefined {
  const configured = process.env.AGENT_GRAPH_CLIENT;
  if (configured === "claude" || configured === "codex") return configured;
  try {
    const executable = basename(execFileSync("ps", ["-p", String(process.ppid), "-o", "comm="], { encoding: "utf8" }).trim());
    if (executable === "claude" || executable === "codex") return executable;
  } catch { /* 親プロセスを参照できなければ識別を省く */ }
  return undefined;
}

const socketPath = process.env.AGENT_GRAPH_SOCKET || join(runDir(), "daemon.sock");
const socket = createConnection(socketPath);
socket.once("connect", () => {
  socket.write(`${JSON.stringify({
    type: "hello",
    client: detectClient(),
    traceparent: process.env.TRACEPARENT,
    tracestate: process.env.TRACESTATE,
    session: process.env.AGENT_GRAPH_SESSION,
    cwd: process.cwd(),
    pid: process.pid,
  })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.once("end", () => socket.end());
});
socket.once("error", (error) => {
  process.stderr.write(`agent-graph-shim: ${error.message}\n`);
  process.exitCode = 1;
});
socket.once("close", () => { process.stdin.unpipe(socket); });
