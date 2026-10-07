import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readOrigin } from "../../core/src/intake/index.ts";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import type { SocketRequest } from "./socket.ts";

interface Job { child: ChildProcess; state: "running" | "done" | "failed"; output: string; error: string; finished: Promise<void> }
const MAX_OUTPUT_BYTES = 1024 * 1024;

// planner の寿命は runner が持ち、api の接続の寿命から独立させる。
export class RunnerPlanner {
  private jobs = new Map<string, Job>();
  private socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }
  command(request: SocketRequest): JsonValue {
    const payload = request.payload as Record<string, JsonValue> | undefined;
    if (request.command === "planner.status") {
      const job = this.jobs.get(String(payload?.jobId));
      if (!job) throw new Error("Unknown planner job");
      return { jobId: String(payload!.jobId), state: job.state, output: job.output, error: job.error };
    }
    if (typeof payload?.cwd !== "string" || typeof payload.session !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.session))
      throw new TypeError("planner.run requires cwd and session");
    if (payload.specPath !== undefined) {
      if (typeof payload.specPath !== "string") throw new TypeError("Invalid specPath");
    }
    if (payload.maxParallel !== undefined) {
      if (!Number.isSafeInteger(payload.maxParallel) || Number(payload.maxParallel) < 1) throw new TypeError("Invalid maxParallel");
    }
    const origin = payload.origin as { provider?: string; nativeId?: string } | undefined;
    if (origin && (!["claude", "codex"].includes(String(origin.provider)) || typeof origin.nativeId !== "string" || !origin.nativeId))
      throw new TypeError("Invalid planner origin");
    if (payload.parentRun !== undefined && (typeof payload.parentRun !== "string" || !payload.parentRun)) throw new TypeError("Invalid parentRun");
    const context = readOrigin({ AGENT_GRAPH_MANAGED: payload.parentRun as string | undefined,
      CLAUDE_CODE_SESSION_ID: origin?.provider === "claude" ? origin.nativeId : undefined,
      CODEX_THREAD_ID: origin?.provider === "codex" ? origin.nativeId : undefined });
    const args = [fileURLToPath(new URL("./planner-worker.ts", import.meta.url)), JSON.stringify({ repo: payload.cwd,
      session: payload.session, specPath: payload.specPath, maxParallel: payload.maxParallel, noPr: true })];
    const child = spawn(process.execPath, args, { cwd: payload.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, AGENT_GRAPH_PLANNER_TRANSPORT: "intake", XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      AGENT_GRAPH_MANAGED: context.parentRun ?? "", CLAUDE_CODE_SESSION_ID: context.origin?.provider === "claude" ? context.origin.nativeId : "",
      CODEX_THREAD_ID: context.origin?.provider === "codex" ? context.origin.nativeId : "",
      AGENT_GRAPH_RUNNER_SOCKET: this.socketPath,
    } });
    const job: Job = { child, state: "running", output: "", error: "", finished: Promise.resolve() };
    const append = (key: "output" | "error", chunk: Buffer) => { job[key] = (job[key] + String(chunk)).slice(-MAX_OUTPUT_BYTES); };
    child.stdout!.on("data", (chunk: Buffer) => append("output", chunk));
    child.stderr!.on("data", (chunk: Buffer) => append("error", chunk));
    child.on("error", (error) => { job.error = error.message; job.state = "failed"; });
    job.finished = new Promise<void>((done) => child.once("close", (code) => { job.state = code === 0 ? "done" : "failed"; done(); }));
    this.jobs.set(request.cmd_id, job);
    return { jobId: request.cmd_id, state: job.state };
  }
  async close(): Promise<void> {
    const active = [...this.jobs.values()].filter((job) => job.state === "running");
    const signal = (job: Job, value: NodeJS.Signals) => {
      if (!job.child.pid) return;
      try { process.kill(-job.child.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    for (const job of active) signal(job, "SIGTERM");
    const timer = setTimeout(() => { for (const job of active) if (job.state === "running") signal(job, "SIGKILL"); }, 5000);
    try { await Promise.all(active.map((job) => job.finished)); } finally { clearTimeout(timer); }
  }
}
