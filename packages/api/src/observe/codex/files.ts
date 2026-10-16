import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface RolloutLine {
  offset: number;
  end: number;
  hash: string;
  value: unknown;
  contextOnly?: boolean;
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

const META_READ_SIZE = 64 * 1024;
const META_READ_LIMIT = 8 * 1024 * 1024;
/** rollout の先頭のメタ行だけを読み、会話の ID と作成時刻と開始の場所を返す。本文の全体は読まない。 */
export function readSessionMeta(path: string): { id?: string; timestamp?: string; cwd?: string } | undefined {
  const descriptor = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(META_READ_SIZE);
      const count = readSync(descriptor, buffer, 0, buffer.length, size);
      if (!count) break;
      const newline = buffer.subarray(0, count).indexOf(10);
      chunks.push(buffer.subarray(0, newline < 0 ? count : newline));
      size += count;
      if (newline >= 0 || size >= META_READ_LIMIT) break;
    }
    const row = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const meta = (row.type === "session_meta" && row.payload && typeof row.payload === "object" ? row.payload : row) as Record<string, unknown>;
    const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
    return { id: text(meta.id), timestamp: text(meta.timestamp), cwd: text(meta.cwd) };
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally { closeSync(descriptor); }
}
