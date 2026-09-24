import { spawn } from "node:child_process";
import { matchesGlob } from "node:path";
import type { AcceptanceResult } from "../delegate/types.ts";

const OUTPUT_LIMIT = 8000;
const TIMEOUT_EXIT_CODE = 124;

function runCommand(command: string, cwd: string, timeoutMs?: number, outputLimit = OUTPUT_LIMIT): Promise<AcceptanceResult["results"][number]> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-outputLimit);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ command, exitCode: timedOut ? TIMEOUT_EXIT_CODE : code ?? 1, output, durationMs: performance.now() - started });
    });
  });
}

function collectStatusPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(entries[++index]);
  }
  return paths;
}

export async function runAcceptance({
  commands, cwd, timeoutMs, scope, baseRef,
}: {
  commands: string[];
  cwd: string;
  timeoutMs?: number;
  scope?: string[];
  baseRef?: string;
}): Promise<AcceptanceResult> {
  const results: AcceptanceResult["results"] = [];
  for (const command of commands) results.push(await runCommand(command, cwd, timeoutMs));

  const scopeViolations: string[] = [];
  if (scope) {
    const status = await runCommand("git status --porcelain -z --untracked-files=all", cwd, undefined, Infinity);
    if (status.exitCode !== 0) throw new Error(`git status failed: ${status.output}`);
    const paths = new Set(collectStatusPaths(status.output));
    if (baseRef) {
      const diff = await runCommand(`git diff --name-only -z ${quoteShell(baseRef)}`, cwd, undefined, Infinity);
      if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.output}`);
      for (const path of diff.output.split("\0").filter(Boolean)) paths.add(path);
    }
    for (const path of paths) {
      if (!scope.some((pattern) => matchesGlob(path, pattern))) scopeViolations.push(path);
    }
    scopeViolations.sort();
  }
  return { passed: results.every((result) => result.exitCode === 0) && scopeViolations.length === 0, results, scopeViolations };
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
