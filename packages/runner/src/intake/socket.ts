import type { Ledger } from "../../../core/src/ledger/ledger.ts";
import type { AgentHost } from "../host/contract.ts";
import { ClaudeHost } from "../hosts/claude/index.ts";
import { CodexHost } from "../hosts/codex/index.ts";
import { RunnerRuntime } from "../runtime.ts";
import { serveSocket } from "../socket.ts";
import { Intake, type IntakeOptions } from "./index.ts";

export async function serveIntakeRunner(ledger: Ledger, path: string,
  options: IntakeOptions & { hosts?: readonly AgentHost[]; isolation?: "shared" | "worktree" } = {}) {
  let intake: Intake;
  let ready = false;
  const socket = await serveSocket(path, (request) => {
    if (!ready) throw new Error("Runner is recovering");
    return intake.command(request);
  });
  const publish = socket.publish;
  const runtime = new RunnerRuntime(ledger, options.hosts ?? [new ClaudeHost(), new CodexHost()], publish, options.isolation);
  intake = new Intake(ledger, runtime, { ...options, publish });
  try { await runtime.recover(); await intake.recover(); ready = true; }
  catch (error) { await intake.close(); await socket.close(); throw error; }
  const timer = setInterval(() => intake.reconcileOrigins(), 500);
  timer.unref();
  return { intake, runtime, async close() {
    ready = false; clearInterval(timer);
    try { await intake.close(); } finally { await socket.close(); }
  } };
}
