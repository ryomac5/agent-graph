import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RolloutLine {
  offset: number;
  end: number;
  hash: string;
  value: unknown;
}
export interface RolloutFile {
  lines: RolloutLine[];
  completeBytes: number;
}
export interface RolloutReader {
  list(directory: string): string[];
  read(path: string): RolloutFile;
}

// I1 の共有読み取りへ交換する境界。末尾の未完行は次回まで保留する。
export const rolloutReader: RolloutReader = {
  list(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return this.list(path);
      return entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name) ? [path] : [];
    }).sort();
  },
  read(path) {
    const bytes = readFileSync(path);
    const lines: RolloutLine[] = [];
    let offset = 0;
    for (;;) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0) break;
      const raw = bytes.subarray(offset, newline);
      const text = raw.toString("utf8").trim();
      if (text) {
        let value: unknown;
        try { value = JSON.parse(text); } catch { value = null; }
        lines.push({ offset, end: newline + 1, hash: createHash("sha256").update(raw).digest("hex"), value });
      }
      offset = newline + 1;
    }
    return { lines, completeBytes: offset };
  },
};
