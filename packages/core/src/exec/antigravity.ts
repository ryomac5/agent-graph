import { runProcess } from "./process.ts";
import type { ExecRequest, ExecResult } from "./types.ts";

export async function executeAntigravity(req: ExecRequest): Promise<ExecResult> {
  const result = await runProcess(req, process.env.AGENT_GRAPH_AGY_BIN || "agy", [
    "--print", req.task, "--model", req.model, "--sandbox", "--mode", "plan", "--output-format", "text",
    ...(req.effort ? ["--effort", req.effort] : []),
  ]);
  return { exitCode: result.exitCode, output: result.stdout, timedOut: result.timedOut,
    usage: { inputTokens: 0, outputTokens: 0 }, durationMs: result.durationMs, childTrace: result.childTrace };
}
