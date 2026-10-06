import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { UNNAMED, type Store } from "../../core/src/store/store.ts";
import { listRepos, listSessions } from "../../core/src/store/queries.ts";
import { isHumanPrompt, summarize } from "./sessions.ts";
import { nameAtFirstPrompt, syncKitNames } from "./kit-names.ts";

const POLL_MS = 2000;
const MATCH_WINDOW_MS = 10_000;
interface TranscriptRow {
  type: string; uuid?: string; timestamp?: string; isMeta?: boolean; entrypoint?: string; continuedInSessionId?: string;
  message?: { model?: string; content?: string | { type: string; text?: string; name?: string; input?: { command?: unknown } }[] };
}
// コミットを作るコマンド。コミットとセッションを結ぶために拾う
export const COMMIT_COMMAND = /\bgit\b[^\n]*\bcommit\b/;

// 記録の行から、Bash で打った git commit を時刻つきで拾う
export function commitCommands(rows: Iterable<TranscriptRow>): { at: string; command: string }[] {
  const found: { at: string; command: string }[] = [];
  for (const row of rows) {
    if (row.type !== "assistant" || !row.timestamp || !Array.isArray(row.message?.content)) continue;
    for (const part of row.message.content) {
      const command = part.type === "tool_use" && typeof part.input?.command === "string" ? part.input.command : "";
      if (COMMIT_COMMAND.test(command)) found.push({ at: row.timestamp, command });
    }
  }
  return found;
}
// claude -p や SDK の会話は転写の entrypoint がこの値になる。対話は cli
const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);

export function parseClaudeRows(rows: Iterable<TranscriptRow>): {
  model?: string; headless?: true; lastAt?: string; turns: { id: string; at: string; prompt: string; reply: string }[];
} {
  const result: ReturnType<typeof parseClaudeRows> = { turns: [] };
  let current: typeof result.turns[number] | undefined;
  for (const row of rows) {
    if (row.type === "user" && HEADLESS_ENTRYPOINTS.has(row.entrypoint ?? "")) result.headless = true;
    if (!row.message || row.isMeta) continue;
    if (row.timestamp && (!result.lastAt || row.timestamp > result.lastAt)) result.lastAt = row.timestamp;
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

async function readRows(path: string): Promise<TranscriptRow[]> {
  const rows: TranscriptRow[] = [];
  for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
    let row: TranscriptRow;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "user" || row.type === "assistant" || row.type === "continued-in") rows.push(row);
  }
  return rows;
}

// Claude Code は会話を裏に回すと別の会話 ID で続け、元の記録の最後に continued-in を書く。その続き先
export function continuedIn(rows: Iterable<TranscriptRow>): string | undefined {
  let target: string | undefined;
  for (const row of rows) if (row.type === "continued-in" && typeof row.continuedInSessionId === "string") target = row.continuedInSessionId;
  return target;
}

// 登録済みの UUID と PJ のパスから履歴を引く。hook の既存の往復を全文で補い、非表示の印は残す。
export function startClaudeObserver(stores: Map<string, Store>, options: { root?: string; intervalMs?: number; onError?: (error: unknown) => void } = {}): {
  tick: () => Promise<void>; stop: () => Promise<void>;
} {
  const root = options.root || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const paths = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let inflight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    try {
      // herdr と hook が使うキットの番号に名前をそろえる
      for (const store of stores.values()) syncKitNames(store);
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
        // 子エージェントの記録は <セッション>/subagents/ にある。子のコミットも親のセッションのものとして拾う
        const subagents = join(dirname(path), session.id, "subagents");
        for (const name of await readdir(subagents).catch(() => [] as string[])) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(subagents, name);
          const fileInfo = await stat(file).catch(() => undefined);
          if (!fileInfo || mtimes.get(file) === fileInfo.mtimeMs) continue;
          store.recordSessionCommands(session.id, commitCommands(await readRows(file)));
          mtimes.set(file, fileInfo.mtimeMs);
        }
        if (mtimes.get(path) === info.mtimeMs) continue;
        const rows = await readRows(path);
        const snapshot = parseClaudeRows(rows);
        store.recordSessionCommands(session.id, commitCommands(rows));
        const successor = continuedIn(rows);
        if (successor && successor !== session.id) store.setContinuedIn(session.id, successor);
        if (snapshot.model) store.setSessionModel(session.id, snapshot.model);
        if (snapshot.lastAt) {
          // 終わった扱いの会話でも、終わったあとの発言が増えていれば別のプロセスで再開している
          if (session.status === "ended") store.reviveFromTranscript(session.id, snapshot.lastAt);
          store.markSessionSeen(session.id, snapshot.lastAt);
        }
        const put = store.db.prepare(`INSERT INTO turns (id, session_id, at, prompt, summary, reply) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt, summary = excluded.summary, reply = excluded.reply`);
        for (const turn of snapshot.turns) {
          const match = store.db.prepare(`SELECT id FROM turns WHERE session_id = ? AND prompt = ?
            AND ABS(julianday(at) - julianday(?)) * 86400000 <= ? ORDER BY rowid LIMIT 1`)
            .get(session.id, turn.prompt, turn.at, MATCH_WINDOW_MS);
          put.run(match ? String(match.id) : turn.id, session.id, turn.at, turn.prompt, summarize(turn.reply), turn.reply || null);
        }
        // daemon の停止中に受けた指示も、最初の人の指示で番号を付ける。無人実行の会話は付けない。
        // fork の転写は親の行を写し、sessionId も fork の id に書き換えるので、行では親の行と見分けられない。
        // そこでプロセスの起動より後の指示だけを使う。起動時刻が取れるまでは付けずに待つ
        const startedAt = session.pidStartedAt === undefined ? NaN : Date.parse(session.pidStartedAt);
        const first = snapshot.headless || Number.isNaN(startedAt) ? undefined
          : snapshot.turns.find((turn) => Date.parse(turn.at) >= startedAt && isHumanPrompt(turn.prompt));
        if (first) nameAtFirstPrompt(store, session.id, first.at || new Date().toISOString());
        // 起動時刻を待つ間は読み直す。見回りが起動時刻を補ったあとの回で番号を付ける
        const waiting = !first && !snapshot.headless && Number.isNaN(startedAt) && session.name === UNNAMED
          && snapshot.turns.some((turn) => isHumanPrompt(turn.prompt));
        if (!waiting) mtimes.set(path, info.mtimeMs);
      }
    } catch (error) { (options.onError || console.error)(error); }
  };
  // 前の回が終わるまで次を始めない。後始末は代入のあとに予約する。
  // run の中で await を通らずに終わると、finally の中で戻した値を ??= の代入が上書きし、二度と動かなくなっていた
  const tick = (): Promise<void> => {
    if (inflight) return inflight;
    const current = run().finally(() => { if (inflight === current) inflight = undefined; });
    inflight = current;
    return current;
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs || POLL_MS);
  void tick();
  return { tick, stop: async () => { clearInterval(timer); await inflight; } };
}
