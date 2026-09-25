import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSample } from "./types.ts";

function readDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

function readWindow(value: unknown, ts: string): UsageSample | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.used_percent !== "number" || !Number.isFinite(row.used_percent)
    || typeof row.window_minutes !== "number" || !Number.isFinite(row.window_minutes)
    || row.window_minutes <= 0) return undefined;
  const sample: UsageSample = {
    ts, provider: "openai", window: `${row.window_minutes}m`, percent: row.used_percent,
  };
  if (typeof row.resets_at === "number" && Number.isFinite(row.resets_at)) {
    const reset = new Date(row.resets_at * 1000);
    if (!Number.isNaN(reset.getTime())) sample.resetsAt = reset.toISOString();
  }
  return sample;
}

export function readCodexUsage(options: { home?: string; now?: Date } = {}): UsageSample[] {
  const root = join(options.home ?? homedir(), ".codex", "sessions");
  for (const year of readDirectories(root)) {
    for (const month of readDirectories(join(root, year))) {
      for (const day of readDirectories(join(root, year, month))) {
        const directory = join(root, year, month, day);
        let files: string[];
        try {
          files = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort().reverse();
        } catch {
          continue;
        }
        for (const file of files) {
          let lines: string[];
          try {
            lines = readFileSync(join(directory, file), "utf8").split(/\r?\n/);
          } catch {
            continue;
          }
          for (let index = lines.length - 1; index >= 0; index--) {
            let event: any;
            try {
              event = JSON.parse(lines[index]);
            } catch {
              continue;
            }
            const limits = event?.payload?.rate_limits;
            if (!limits || typeof limits !== "object") continue;
            const ts = typeof event.timestamp === "string" && !Number.isNaN(Date.parse(event.timestamp))
              ? event.timestamp : (options.now ?? new Date()).toISOString();
            const samples = [readWindow(limits.primary, ts), readWindow(limits.secondary, ts)]
              .filter((sample): sample is UsageSample => sample !== undefined);
            if (samples.length > 0) return samples;
          }
        }
      }
    }
  }
  return [];
}
