import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { FactInput, Ledger } from "../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../observe/files.ts";
import type { FileCursor } from "../observe/files.ts";
import { rolloutReader } from "../observe/codex/files.ts";
import type { RolloutLine, RolloutReader } from "../observe/codex/files.ts";

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createIncrementalRolloutReader(ledger: Ledger) {
  const saved = new Map<string, { offset: number; fileCursor?: FileCursor }>();
  for (const fact of ledger.readSince(0, Number.MAX_SAFE_INTEGER)) {
    if (fact.source !== "rollout-codex" || !fact.cursor) continue;
    const cursor = JSON.parse(fact.cursor);
    if (typeof cursor.file_id === "string" && Number.isSafeInteger(cursor.offset)) {
      saved.set(cursor.file_id, { offset: cursor.offset, fileCursor: cursor.file_cursor });
    }
  }
  const cache = new Map<string, { cursor: FileCursor; context: RolloutLine[] }>();
  let staged = new Map<string, { cursor: FileCursor; context: RolloutLine[] }>();
  let cursors = new Map<number, FileCursor>();
  let current: FileCursor | undefined;
  const reader: RolloutReader = {
    list: (directory) => rolloutReader.list(directory),
    read(path) {
      const previous = cache.get(path);
      const persisted = saved.get(basename(path));
      const reset = !previous && persisted?.fileCursor
        ? readAppendOnlyFile(path, persisted.fileCursor).reset : false;
      const file = readAppendOnlyFile(path, previous?.cursor);
      current = file.cursor;
      cursors = new Map();
      let offset = !file.reset && previous ? previous.cursor.offset : 0;
      let hash = !file.reset && previous ? previous.cursor.hash : createHash("sha256").digest("hex");
      const lines: RolloutLine[] = [];
      for (const line of file.lines) {
        const start = offset;
        cursors.set(start, { ...file.cursor, offset: start, size: start, hash });
        offset = line.cursor.offset;
        hash = line.cursor.hash;
        if (!line.text.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line.text); } catch { value = null; }
        const raw = offset - start === Buffer.byteLength(line.text) + 2 ? line.text + "\r" : line.text;
        lines.push({ offset: start, end: offset, hash: createHash("sha256").update(raw).digest("hex"), value });
      }
      const context = file.reset ? [] : previous?.context ?? [];
      const all = [...context, ...lines];
      const meta = all.find((line) => readObject(line.value).type === "session_meta");
      const nativeId = readObject(readObject(meta?.value).payload).id;
      const message = all.find((line) => {
        const row = readObject(line.value);
        const params = readObject(row.params);
        const payload = readObject(row.payload);
        const id = params.threadId ?? row.threadId ?? payload.thread_id ?? payload.threadId ?? nativeId;
        const item = row.method === "item/completed" ? readObject(params.item) : payload;
        return id === nativeId && ["message", "agentMessage", "userMessage"].includes(String(item.type))
          && (item.content !== undefined || item.text !== undefined);
      });
      const retained = [...new Set([meta, message, all.at(-1)].filter((line): line is RolloutLine => !!line))];
      staged.set(path, { cursor: file.cursor, context: retained });
      // 最後の行は再読し、途中で止まった複数の事実の追記を補う。
      const resumeOffset = previous || file.reset || reset ? 0 : persisted?.fileCursor?.offset ?? persisted?.offset ?? 0;
      return { lines: [...new Map([...retained, ...lines.filter((line) => line.offset >= resumeOffset)]
        .map((line) => [line.offset, line])).values()].sort((a, b) => a.offset - b.offset), completeBytes: file.cursor.offset };
    },
  };
  return { reader,
    decorate(input: FactInput): FactInput {
      if (input.source !== "rollout-codex" || !input.cursor || !current) return input;
      const original = JSON.parse(input.cursor);
      const archive = input.kind === "run.state_changed" && readObject(input.payload.end_evidence).kind === "archived";
      const fileCursor = archive ? current : cursors.get(original.offset);
      // メタや補助事実には安全側の位置を使い、後続の事実より先へ進めない。
      const safe = fileCursor ?? { ...current, offset: 0, size: 0, hash: createHash("sha256").digest("hex") };
      return { ...input, cursor: JSON.stringify({ ...original, file_cursor: safe }) };
    },
    commit() { for (const [path, value] of staged) cache.set(path, value); staged = new Map(); },
    discard() { staged = new Map(); },
  };
}
