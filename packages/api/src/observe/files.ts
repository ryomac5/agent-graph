import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

const READ_SIZE = 64 * 1024;
export interface FileCursor {
  path: string;
  identity: string;
  offset: number;
  size: number;
  hash: string;
}
export interface FileLine {
  text: string;
  cursor: FileCursor;
}
export interface FileRead {
  lines: FileLine[];
  cursor: FileCursor;
  pendingBytes: number;
  reset: boolean;
}

// offset は完了した改行まで。未完了の UTF-8 も次回そのバイト位置から読み直す。
export function readAppendOnlyFile(path: string, previous?: FileCursor): FileRead {
  const absolutePath = resolve(path);
  const descriptor = openSync(absolutePath, "r");
  try {
    const stat = fstatSync(descriptor);
    const identity = `${stat.dev}:${stat.ino}`;
    let offset = previous?.offset ?? 0;
    let reset = previous !== undefined && (previous.path !== absolutePath
      || previous.identity !== identity || stat.size < previous.size);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_SIZE);
    if (!reset && previous) {
      for (let position = 0; position < offset;) {
        const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, offset - position), position);
        if (count === 0) { reset = true; break; }
        hash.update(buffer.subarray(0, count));
        position += count;
      }
      if (hash.copy().digest("hex") !== previous.hash) reset = true;
    }
    const contentHash = reset ? createHash("sha256") : hash;
    if (reset) offset = 0;
    const lines: FileLine[] = [];
    let pending = Buffer.alloc(0);
    let position = offset;
    let committedHash = contentHash.copy().digest("hex");
    while (position < stat.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (count === 0) break;
      position += count;
      const bytes = Buffer.concat([pending, buffer.subarray(0, count)]);
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        const line = bytes.subarray(start, end + 1);
        contentHash.update(line);
        offset += line.length;
        committedHash = contentHash.copy().digest("hex");
        lines.push({ text: line.toString("utf8").replace(/\r?\n$/, ""),
          cursor: { path: absolutePath, identity, offset, size: offset, hash: committedHash } });
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    return { lines, cursor: { path: absolutePath, identity, offset, size: position, hash: committedHash },
      pendingBytes: pending.length, reset };
  } finally {
    closeSync(descriptor);
  }
}
