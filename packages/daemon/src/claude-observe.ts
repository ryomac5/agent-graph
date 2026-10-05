import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Store } from "../../core/src/store/store.ts";
import { listRepos, listSessions } from "../../core/src/store/queries.ts";
import { summarize } from "./sessions.ts";

const POLL_MS = 2000;
const MATCH_WINDOW_MS = 10_000;
interface TranscriptRow {
  type: string; uuid?: string; timestamp?: string; isMeta?: boolean;
  message?: { model?: string; content?: string | { type: string; text?: string }[] };
}
export function parseClaudeRows(rows: Iterable<TranscriptRow>): {
  model?: string; turns: { id: string; at: string; prompt: string; reply: string }[];
} {
  const result: ReturnType<typeof parseClaudeRows> = { turns: [] };
  let current: typeof result.turns[number] | undefined;
  for (const row of rows) {
    if (!row.message || row.isMeta) continue;
    const content = row.message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text || "").join("\n") : "";
    if (row.type === "user" && text && !text.startsWith("<local-command")) {
      current = { id: "cl-" + (row.uuid || createHash("sha256").update(`${row.timestamp}:${text}`).digest("hex").slice(0, 24)),
        at: row.timestamp || "", prompt: text, reply: "" };
      result.turns.push(current);
    }
    if (row.type === "assistant") {
      if (row.message.model && row.message.model !== "<synthetic>") result.model = row.message.model;
      if (current && text) current.reply += (current.reply ? "\n\n" : "") + text;
    }
  }
  return result;
}

// 登録済みの UUID と PJ のパスから履歴を引く。hook の既存の往復を全文で補い、非表示の印は残す。
export function startClaudeObserver(stores: Map<string, Store>, options: { root?: string; intervalMs?: number; onError?: (error: unknown) => void } = {}): {
  tick: () => Promise<void>; stop: () => Promise<void>;
} {
  const root = options.root || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const paths = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let inflight: Promise<void> | undefined;
  const tick = (): Promise<void> => inflight ??= (async () => {
    try {
      for (const store of stores.values()) for (const repo of listRepos(store.db)) for (const session of listSessions(store.db, repo.key)) {
        if (session.client !== "claude" || !/^[A-Za-z0-9_-]+$/.test(session.id)) continue;
        let path = paths.get(session.id) || join(root, repo.rootPath.replace(/[^A-Za-z0-9]/g, "-"), `${session.id}.jsonl`);
        let info;
        try { info = await stat(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          // Claude は Git の根ではなく起動ディレクトリを履歴のキーにする。
          const dirs = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          const matches: { path: string; info: Stats }[] = [];
          for (const dir of dirs.filter((entry) => entry.isDirectory())) {
            const candidate = join(root, dir.name, `${session.id}.jsonl`);
            const candidateInfo = await stat(candidate).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (candidateInfo?.isFile()) matches.push({ path: candidate, info: candidateInfo });
          }
          if (matches.length !== 1) continue;
          ({ path, info } = matches[0]);
        }
        paths.set(session.id, path);
        if (mtimes.get(path) === info.mtimeMs) continue;
        const rows: TranscriptRow[] = [];
        for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
          let row: TranscriptRow;
          try { row = JSON.parse(line); } catch { continue; }
          if (row.type === "user" || row.type === "assistant") rows.push(row);
        }
        const snapshot = parseClaudeRows(rows);
        if (snapshot.model) store.setSessionModel(session.id, snapshot.model);
        const put = store.db.prepare(`INSERT INTO turns (id, session_id, at, prompt, summary, reply) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt, summary = excluded.summary, reply = excluded.reply`);
        for (const turn of snapshot.turns) {
          const match = store.db.prepare(`SELECT id FROM turns WHERE session_id = ? AND prompt = ?
            AND ABS(julianday(at) - julianday(?)) * 86400000 <= ? ORDER BY rowid LIMIT 1`)
            .get(session.id, turn.prompt, turn.at, MATCH_WINDOW_MS);
          put.run(match ? String(match.id) : turn.id, session.id, turn.at, turn.prompt, summarize(turn.reply), turn.reply || null);
        }
        mtimes.set(path, info.mtimeMs);
      }
    } catch (error) { (options.onError || console.error)(error); }
    finally { inflight = undefined; }
  })();
  const timer = setInterval(() => { void tick(); }, options.intervalMs || POLL_MS);
  void tick();
  return { tick, stop: async () => { clearInterval(timer); await inflight; } };
}
