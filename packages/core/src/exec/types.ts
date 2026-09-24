import { executeClaude } from "./claude.ts";
import { executeCodex } from "./codex.ts";
import type { TraceContext } from "../trace.ts";

export interface ExecRequest {
  executor: "claude" | "codex";
  model: string;
  task: string;
  cwd: string;
  trace: TraceContext;
  sessionId: string;
  delegationId: string;
  timeoutMs: number;
  workDir: string;
}

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  childTrace: TraceContext;
}

export function execute(req: ExecRequest): Promise<ExecResult> {
  return req.executor === "claude" ? executeClaude(req) : executeCodex(req);
}
