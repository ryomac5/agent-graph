#!/usr/bin/env node
import { createConnection } from "node:net";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { runDir } from "./paths.ts";

function detectClient(): "claude" | "codex" | "planner" | undefined {
  const configured = process.env.AGENT_GRAPH_CLIENT;
  if (configured === "claude" || configured === "codex" || configured === "planner") return configured;
  try {
    const executable = basename(execFileSync("ps", ["-p", String(process.ppid), "-o", "comm="], { encoding: "utf8" }).trim());
    if (executable === "claude" || executable === "codex") return executable;
  } catch { /* 親プロセスを参照できなければ識別を省く */ }
  return undefined;
}

// セッションの id。Claude Code は自分の id を CLAUDE_CODE_SESSION_ID で MCP サーバに渡す。hook の session_id と同じ値なので、
// 呼び出し元が Claude Code のときはこれを最優先にし、根が 2 つに割れないようにする。
// Claude Code の中から起動した planner や codex もこの変数を受け継ぐので、それ以外の呼び出し元では使わない
// Codex は自分のスレッドの id を CODEX_THREAD_ID で渡す。観測はその id でセッションの記録を引く
function sessionOf(client: string | undefined): string | undefined {
  if (client === "claude" && process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  return process.env.AGENT_GRAPH_SESSION || process.env.CODEX_THREAD_ID;
}

const client = detectClient();
const socketPath = process.env.AGENT_GRAPH_SOCKET || join(runDir(), "daemon.sock");
const socket = createConnection(socketPath);
socket.once("connect", () => {
  socket.write(`${JSON.stringify({
    type: "hello",
    client,
    traceparent: process.env.TRACEPARENT,
    tracestate: process.env.TRACESTATE,
    // 委譲の子は tracestate で親のセッションを渡し、デーモンはそちらを優先する
    session: sessionOf(client),
    cwd: process.cwd(),
    // 親プロセスの pid。claude や codex 本体を指し、デーモンが生死判定に使う
    pid: process.ppid,
  })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.once("end", () => socket.end());
});
socket.once("error", (error) => {
  process.stderr.write(`agent-graph-shim: ${error.message}\n`);
  process.exitCode = 1;
});
socket.once("close", () => {
  process.stdin.unpipe(socket);
  process.stdin.destroy();
});
