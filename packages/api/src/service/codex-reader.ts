import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { FactInput, Ledger } from "../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../observe/files.ts";
import type { FileCursor } from "../observe/files.ts";
import type { RolloutLine, RolloutReader } from "../observe/codex/files.ts";
import { createDirectoryReader } from "../observe/directories.ts";

export interface RolloutCheckpoint { cursor: FileCursor; context: RolloutLine[] }

// 再開に必要な構造だけを保存し、会話本文やツール出力を cursor の保管庫へ複製しない。
export function createRolloutContext(lines: RolloutLine[]): RolloutLine[] {
  return lines.map((line) => {
    const row = readObject(line.value);
    if (row.type === "session_meta" || !row.type && typeof row.id === "string") {
      const meta = row.type === "session_meta" ? readObject(row.payload) : row;
      const payload = Object.fromEntries(["id", "timestamp", "source", "history_mode", "cli_version", "parent_thread_id", "cwd"]
        .filter((key) => meta[key] !== undefined).map((key) => [key, meta[key]]));
      return { ...line, value: row.type === "session_meta" ? { type: row.type, timestamp: row.timestamp, payload } : payload };
    }
    const params = readObject(row.params);
    const item = row.method === "item/completed" ? readObject(params.item) : readObject(row.payload);
    const payload = { type: item.type, thread_id: item.thread_id, threadId: item.threadId,
      ...(item.content !== undefined ? { content: "" } : {}), ...(item.text !== undefined ? { text: "" } : {}) };
    return { ...line, value: { timestamp: row.timestamp, type: row.type, method: row.method, threadId: row.threadId,
      ...(row.method === "item/completed" ? { params: { threadId: params.threadId, item: payload } } : { payload }) } };
  });
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createIncrementalRolloutReader(ledger: Ledger, cache = new Map<string, RolloutCheckpoint>()) {
  const saved = new Map<string, { offset: number; fileCursor?: FileCursor }>();
  for (const fact of ledger.readSince(0, Number.MAX_SAFE_INTEGER)) {
    if (fact.source !== "rollout-codex" || !fact.cursor) continue;
    const cursor = JSON.parse(fact.cursor);
    if (typeof cursor.file_id === "string" && Number.isSafeInteger(cursor.offset)) {
      saved.set(cursor.file_id, { offset: cursor.offset, fileCursor: cursor.file_cursor });
    }
  }
  const list = createDirectoryReader();
  let staged = new Map<string, { cursor: FileCursor; context: RolloutLine[] }>();
  let cursors = new Map<number, FileCursor>();
  let current: FileCursor | undefined;
  const reader: RolloutReader = {
    list: (directory) => list(directory, (name) => /^rollout-.*\.jsonl$/.test(name)),
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
      const meta = all.find((line) => readObject(line.value).type === "session_meta"
        || !readObject(line.value).type && typeof readObject(line.value).id === "string");
      const metaRow = readObject(meta?.value);
      const nativeId = (metaRow.type === "session_meta" ? readObject(metaRow.payload) : metaRow).id;
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
      staged.set(path, { cursor: file.cursor, context: createRolloutContext(retained) });
      // 最後の行は再読し、途中で止まった複数の事実の追記を補う。
      const resumeOffset = previous || file.reset || reset ? 0 : persisted?.fileCursor?.offset ?? 0;
      return { lines: [...new Map([...retained.map((line) => ({ ...line, contextOnly: true })), ...lines.filter((line) => line.offset >= resumeOffset)]
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
