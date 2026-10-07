import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";

const READ_SIZE = 64 * 1024;
const PREFIX_SIZE = 4096;
export interface FileCursor {
  path: string;
  identity: string;
  offset: number;
  size: number;
  hash: string;
  mtimeMs?: number;
  ctimeMs?: number;
  prefixHash?: string;
  prefixBytes?: number;
}
export interface FileLine { text: string; cursor: FileCursor }
export interface FileRead { lines: FileLine[]; cursor: FileCursor; pendingBytes: number; reset: boolean }
export interface FileReadMetrics { opened: number; prefixBytes: number; contentBytes: number }
export const fileReadMetrics: FileReadMetrics = { opened: 0, prefixBytes: 0, contentBytes: 0 };

// offset は完了した改行まで。未完了の UTF-8 は次回その位置から読み直す。
export function readAppendOnlyFile(path: string, previous?: FileCursor): FileRead {
  const absolutePath = resolve(path);
  const before = statSync(absolutePath);
  const identity = `${before.dev}:${before.ino}`;
  if (previous?.path === absolutePath && previous.identity === identity && previous.size === before.size
    && previous.mtimeMs === before.mtimeMs && previous.ctimeMs === before.ctimeMs) {
    return { lines: [], cursor: previous, pendingBytes: previous.size - previous.offset, reset: false };
  }
  const descriptor = openSync(absolutePath, "r");
  fileReadMetrics.opened += 1;
  try {
    const stat = fstatSync(descriptor);
    const currentIdentity = `${stat.dev}:${stat.ino}`;
    const prefix = Buffer.alloc(Math.min(PREFIX_SIZE, stat.size));
    const prefixCount = readSync(descriptor, prefix, 0, prefix.length, 0);
    fileReadMetrics.prefixBytes += prefixCount;
    const prefixHash = createHash("sha256").update(prefix.subarray(0, prefixCount)).digest("hex");
    let reset = previous !== undefined && (previous.path !== absolutePath || previous.identity !== currentIdentity
      || stat.size < previous.size
      || previous.prefixHash !== undefined &&
        createHash("sha256").update(prefix.subarray(0, previous.prefixBytes)).digest("hex") !== previous.prefixHash);
    // 旧 cursor は一度だけ接頭辞全体を照合し、新しい小さな指紋へ移す。
    if (previous && previous.prefixHash === undefined && !reset) {
      const legacyHash = createHash("sha256");
      const buffer = Buffer.alloc(READ_SIZE);
      for (let position = 0; position < previous.offset;) {
        const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, previous.offset - position), position);
        fileReadMetrics.prefixBytes += count;
        if (!count) { reset = true; break; }
        legacyHash.update(buffer.subarray(0, count));
        position += count;
      }
      if (legacyHash.digest("hex") !== previous.hash) reset = true;
    }
    let offset = reset ? 0 : previous?.offset ?? 0;
    let committedHash = reset ? createHash("sha256").digest("hex") : previous?.hash ?? createHash("sha256").digest("hex");
    const metadata = { path: absolutePath, identity: currentIdentity, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, prefixHash, prefixBytes: prefixCount };
    const lines: FileLine[] = [];
    const buffer = Buffer.alloc(READ_SIZE);
    let pending = Buffer.alloc(0);
    let position = offset;
    while (position < stat.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!count) break;
      fileReadMetrics.contentBytes += count;
      position += count;
      const bytes = Buffer.concat([pending, buffer.subarray(0, count)]);
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end + 1);
        committedHash = createHash("sha256").update(committedHash).update(line).digest("hex");
        offset += line.length;
        lines.push({ text: line.toString("utf8").replace(/\r?\n$/, ""), cursor: { ...metadata, size: offset, offset, hash: committedHash } });
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    return { lines, cursor: { ...metadata, offset, hash: committedHash }, pendingBytes: pending.length, reset };
  } finally { closeSync(descriptor); }
}
