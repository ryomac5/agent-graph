#!/usr/bin/env node
import { createConnection } from "node:net";
import { join } from "node:path";
import { runDir } from "./paths.ts";

const socketPath = process.env.AGENT_GRAPH_SOCKET || join(runDir(), "daemon.sock");
const socket = createConnection(socketPath);
socket.once("connect", () => {
  socket.write(`${JSON.stringify({
    type: "hello",
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
