import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { UsageSample } from "./types.ts";

type SpawnImpl = typeof spawn;

function readUsage(value: unknown, ts: string): UsageSample[] {
  if (typeof value !== "object" || value === null) return [];
  const usage = value as Record<string, unknown>;
  const samples: UsageSample[] = [];
  for (const [key, window] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
    const item = usage[key];
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.utilization !== "number" || !Number.isFinite(row.utilization)) continue;
    const sample: UsageSample = { ts, provider: "anthropic", window, percent: row.utilization };
    if (typeof row.resets_at === "string" && !Number.isNaN(Date.parse(row.resets_at))) {
      sample.resetsAt = new Date(row.resets_at).toISOString();
    }
    samples.push(sample);
  }
  if (typeof usage.model_scoped === "object" && usage.model_scoped !== null) {
    for (const [model, value] of Object.entries(usage.model_scoped)) {
      if (typeof value !== "object" || value === null) continue;
      const row = value as Record<string, unknown>;
      if (typeof row.utilization !== "number" || !Number.isFinite(row.utilization)) continue;
      const sample: UsageSample = { ts, provider: "anthropic", window: "7d", percent: row.utilization, model };
      if (typeof row.resets_at === "string" && !Number.isNaN(Date.parse(row.resets_at))) {
        sample.resetsAt = new Date(row.resets_at).toISOString();
      }
      samples.push(sample);
    }
  }
  return samples;
}

export async function probeClaudeUsage(options: {
  bin?: string; cwd: string; timeoutMs: number; spawnImpl?: SpawnImpl;
}): Promise<UsageSample[]> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnImpl ?? spawn)(options.bin ?? "claude", [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    const finish = (samples: UsageSample[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(samples);
    };
    const timer = setTimeout(() => { child.kill(); finish([]); }, Math.max(0, options.timeoutMs));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.resume();
    child.on("error", () => finish([]));
    child.on("close", () => {
      for (const line of output.split(/\r?\n/)) {
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        const usage = event?.response?.usage ?? event?.response ?? event?.usage;
        const samples = readUsage(usage, new Date().toISOString());
        if (samples.length > 0) { finish(samples); return; }
      }
      finish([]);
    });
    child.stdin.on("error", () => finish([]));
    child.stdin.end(JSON.stringify({ type: "control_request", request_id: "usage", request: { subtype: "get_usage" } }) + "\n");
  });
}
