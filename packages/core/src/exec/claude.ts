import { runProcess } from "./process.ts";
import type { ExecRequest, ExecResult } from "./types.ts";

export async function executeClaude(req: ExecRequest): Promise<ExecResult> {
  const task = `無人実行です。質問せずに作業を完了し、最後に結果を報告してください。\n${req.task}`;
  const result = await runProcess({ ...req, task }, process.env.AGENT_GRAPH_CLAUDE_BIN || "claude", [
    "-p", "--model", req.model, "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--settings", JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }),
  ]);
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (event.type === "result") {
      output = event.result ?? "";
      inputTokens = event.usage?.input_tokens ?? 0;
      outputTokens = event.usage?.output_tokens ?? 0;
    }
  }
  return {
    exitCode: result.exitCode,
    output,
    timedOut: result.timedOut,
    usage: { inputTokens, outputTokens },
    durationMs: result.durationMs,
    childTrace: result.childTrace,
  };
}
