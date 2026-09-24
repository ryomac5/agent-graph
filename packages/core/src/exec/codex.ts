import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.ts";
import type { ExecRequest, ExecResult } from "./types.ts";

export async function executeCodex(req: ExecRequest): Promise<ExecResult> {
  const lastMessage = join(req.workDir, "last.md");
  const result = await runProcess(req, process.env.AGENT_GRAPH_CODEX_BIN || "codex", [
    "exec", "-m", req.model, "--sandbox", "workspace-write", "--skip-git-repo-check",
    "--output-last-message", lastMessage, "-",
  ]);
  const output = await readFile(lastMessage, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return {
    exitCode: result.exitCode,
    output,
    timedOut: result.timedOut,
    usage: { inputTokens: 0, outputTokens: 0 },
    durationMs: result.durationMs,
    childTrace: result.childTrace,
  };
}
