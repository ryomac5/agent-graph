import { spawn } from "node:child_process";
import { childContext, formatTracestate, parseTracestate, toEnv } from "../trace.ts";
import type { TraceContext } from "../trace.ts";
import type { ExecRequest } from "./types.ts";

const KILL_GRACE_MS = 5_000;

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
  durationMs: number;
  childTrace: TraceContext;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export async function runProcess(req: ExecRequest, bin: string, args: string[]): Promise<ProcessResult> {
  const childTrace = childContext(req.trace);
  childTrace.traceState = formatTracestate({
    ...parseTracestate(req.trace.traceState),
    sessionId: req.sessionId,
    delegationId: req.delegationId,
  });
  const started = performance.now();
  const child = spawn(bin, args, {
    cwd: req.cwd,
    env: {
      ...process.env,
      ...toEnv(childTrace),
      AGENT_GRAPH_SESSION: req.sessionId,
      AGENT_GRAPH_DELEGATION: req.delegationId,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.resume();
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(child.pid, "SIGTERM");
    forceKill = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    forceKill.unref();
  }, Math.max(0, req.timeoutMs));
  const result = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(req.task);
    timeout.unref();
  }).finally(() => {
    clearTimeout(timeout);
    if (forceKill) clearTimeout(forceKill);
  });
  return { exitCode: result, stdout, timedOut, durationMs: performance.now() - started, childTrace };
}
