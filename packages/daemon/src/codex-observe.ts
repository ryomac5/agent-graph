import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Store, SessionRow } from "../../core/src/store/store.ts";
import type { Event } from "../../core/src/events.ts";
import { newSpanId } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";
import { listRepos, listSessions } from "../../core/src/store/queries.ts";
import { inferRole, tierOf } from "./observe.ts";
import { summarize } from "./sessions.ts";

const execFileAsync = promisify(execFile);
const POLL_MS = 2000;
const INDEX_INTERVAL_MS = POLL_MS;
const SESSION_BIND_WINDOW_MS = 60_000;
interface LogRow { type: string; timestamp?: string; payload: Record<string, any> }
interface ObservedTurn { id: string; at: string; prompt: string; reply?: string }
export interface CodexSnapshot {
  threadId: string; parentThreadId?: string; cwd: string; model?: string;
  startedAt: string; updatedAt: string; turns: ObservedTurn[]; status: "running" | "done" | "failed";
}

const stableId = (thread: string, turn: string) => "cx-" + createHash("sha256").update(`${thread}:${turn}`).digest("hex").slice(0, 24);

// 推論やツールの出力は会話に混ぜず、ユーザー本文と公開された応答だけを取り込む。
export function parseCodexRows(rows: Iterable<LogRow>): CodexSnapshot | undefined {
  let snapshot: CodexSnapshot | undefined;
  let current: ObservedTurn | undefined;
  let pendingPrompt = "";
  let prompts = new Set<string>();
  for (const row of rows) {
    const p = row.payload;
    if (!p || typeof p !== "object") continue;
    const at = row.timestamp || "";
    if (row.type === "session_meta" && typeof p.id === "string" && typeof p.cwd === "string") {
      snapshot = { threadId: p.id, cwd: p.cwd, startedAt: at || p.timestamp, updatedAt: at || p.timestamp,
        ...(typeof p.model === "string" && p.model ? { model: p.model } : {}),
        parentThreadId: p.source?.subagent?.spawn?.parent_thread_id ?? p.thread_source?.subagent?.spawn?.parent_thread_id,
        turns: [], status: "running" };
    }
    if (!snapshot) continue;
    if (at) snapshot.updatedAt = at;
    if (row.type === "turn_context" && typeof p.model === "string") snapshot.model = p.model;
    if (row.type === "event_msg" && p.type === "task_started") {
      current = { id: stableId(snapshot.threadId, String(p.turn_id || at)), at, prompt: pendingPrompt };
      pendingPrompt = "";
      prompts = new Set(current.prompt ? [current.prompt] : []);
      snapshot.turns.push(current);
      snapshot.status = "running";
    }
    if (row.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
      if (!current) {
        current = { id: stableId(snapshot.threadId, at), at, prompt: "" };
        snapshot.turns.push(current);
      }
      if (!prompts.has(p.message)) { current.prompt += (current.prompt ? "\n\n" : "") + p.message; prompts.add(p.message); }
    }
    if (row.type === "response_item" && p.type === "message") {
      const text = Array.isArray(p.content) ? p.content.filter((c: any) => typeof c.text === "string").map((c: any) => c.text).join("\n") : "";
      if (p.role === "user" && text && !text.startsWith("# AGENTS.md instructions") && !text.startsWith("<environment_context>")) {
        if (current) {
          if (!prompts.has(text)) { current.prompt += (current.prompt ? "\n\n" : "") + text; prompts.add(text); }
        } else pendingPrompt = text;
      }
      if (p.role === "assistant" && p.phase === "final_answer" && current) current.reply = text;
    }
    if (row.type === "event_msg" && p.type === "task_complete") {
      if (current && typeof p.last_agent_message === "string") current.reply = p.last_agent_message;
      snapshot.status = "done";
      current = undefined;
    }
    if (row.type === "event_msg" && ["turn_aborted", "task_failed"].includes(p.type)) {
      if (current && !current.reply) current.reply = typeof p.message === "string" ? p.message : "実行が中断されました";
      snapshot.status = "failed";
      current = undefined;
    }
  }
  return snapshot;
}

async function readSnapshot(path: string): Promise<CodexSnapshot | undefined> {
  const rows: LogRow[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    let row: LogRow;
    try { row = JSON.parse(line); } catch { continue; }
    // 暗号化推論やコマンド出力は保持しない。
    if (["session_meta", "turn_context"].includes(row.type)
      || (row.type === "event_msg" && ["task_started", "user_message", "task_complete", "turn_aborted", "task_failed"].includes(row.payload?.type))
      || (row.type === "response_item" && row.payload?.type === "message")) rows.push(row);
  }
  return parseCodexRows(rows);
}

async function listLogs(root: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) files.push(...await listLogs(join(root, entry.name), depth + 1));
    else if (entry.name.endsWith(".jsonl")) files.push(join(root, entry.name));
  }
  return files;
}

export function applyCodexSnapshot(store: Store, session: SessionRow, snapshot: CodexSnapshot): void {
  if (snapshot.model) store.setSessionModel(session.id, snapshot.model);
  const put = store.db.prepare(`INSERT INTO turns (id, session_id, at, prompt, summary, reply) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt, summary = excluded.summary, reply = excluded.reply`);
  for (const turn of snapshot.turns) {
    put.run(turn.id, session.id, turn.at, turn.prompt, turn.reply === undefined ? null : summarize(turn.reply), turn.reply ?? null);
    if (turn.prompt) store.setSessionGoalIfEmpty(session.id, turn.prompt.slice(0, 200));
  }
}

function applyChild(store: Store, session: SessionRow, child: CodexSnapshot, parentId?: string): string {
  const id = stableId(child.threadId, "subagent");
  const task = child.turns.find((turn) => turn.prompt)?.prompt || "";
  const output = child.turns.filter((turn) => turn.reply).map((turn) => turn.reply).join("\n\n");
  const title = task.split("\n").find(Boolean)?.slice(0, 100) || "Codex subagent";
  const existing = store.db.prepare("SELECT id FROM delegations WHERE id = ?").get(id);
  const record = (kind: string, payload: object, at: string) => store.appendEvent({
    id: ulid(), ts: at, kind, repo: session.repoKey, session: session.id,
    trace: { traceId: session.traceId, spanId: newSpanId() }, payload,
  } as Event);
  if (!existing) {
    store.insertDelegation({ id, repoKey: session.repoKey, sessionId: session.id, parentId,
      role: inferRole(title, "codex"), title, status: "running", kind: "subagent", task });
    record("delegation.requested", { delegationId: id, task }, child.startedAt);
    store.insertAssignment(id, { executor: "codex", model: child.model || session.model || "", family: "openai",
      tier: tierOf(child.model || ""), reason: ["Codex のネイティブサブエージェント"], policyVersion: "" });
  }
  if (child.model) store.db.prepare("UPDATE assignments SET model = ? WHERE delegation_id = ?").run(child.model, id);
  // スナップショットは往復を安定した順序で更新し、再起動で重複させない。
  const put = store.db.prepare(`INSERT INTO delegation_rounds (delegation_id, seq, kind, text, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(delegation_id, seq) DO UPDATE SET kind = excluded.kind, text = excluded.text, at = excluded.at`);
  child.turns.forEach((turn, index) => {
    put.run(id, index * 2 + 1, index ? "reinstruct" : "request", turn.prompt, turn.at);
    if (turn.reply !== undefined) put.run(id, index * 2 + 2, "report", turn.reply, child.updatedAt);
  });
  store.db.prepare("UPDATE delegations SET task = ?, output = ?, round_trips = ?, status = ? WHERE id = ?")
    .run(task, output || null, Math.max(0, child.turns.length - 1), session.status === "ended" && child.status === "running" ? "lost" : child.status, id);
  if (child.status !== "running" && !store.db.prepare("SELECT 1 FROM events WHERE kind = 'delegation.finished' AND json_extract(payload, '$.delegationId') = ? AND ts = ?").get(id, child.updatedAt)) {
    record("delegation.finished", { delegationId: id, status: child.status }, child.updatedAt);
  }
  return id;
}

// 既に登録された根と、その根から派生した子だけを対象にする。無関係な過去の PJ は登録しない。
export function startCodexObserver(stores: Map<string, Store>, options: {
  root?: string; intervalMs?: number; onError?: (error: unknown) => void;
  openFiles?: (pid: number) => Promise<string[]>;
} = {}): { tick: () => Promise<void>; stop: () => Promise<void> } {
  const root = options.root || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  let paths: string[] = [];
  let indexedAt = 0;
  const snapshots = new Map<string, { mtime: number; data?: CodexSnapshot }>();
  const sessionPaths = new Map<string, string>();
  const applied = new Map<string, number>();
  let inflight: Promise<void> | undefined;
  const tick = (): Promise<void> => inflight ??= (async () => {
    try {
      if (Date.now() - indexedAt > INDEX_INTERVAL_MS) { paths = (await listLogs(root)).sort(); indexedAt = Date.now(); }
      const read = async (path: string) => {
        const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info) { snapshots.delete(path); return undefined; }
        let snapshot = snapshots.get(path);
        if (snapshot?.mtime !== info.mtimeMs) {
          snapshot = { mtime: info.mtimeMs, data: await readSnapshot(path) };
          snapshots.set(path, snapshot);
        }
        return snapshot?.data;
      };
      for (const store of stores.values()) {
        for (const session of listRepos(store.db).flatMap((repo) => listSessions(store.db, repo.key)).filter((value) => value.client === "codex")) {
          const repo = listRepos(store.db).find((repo) => repo.key === session.repoKey)!;
          const belongsToRepo = (candidate: CodexSnapshot) => {
            const subpath = relative(repo.rootPath, candidate.cwd);
            return subpath !== ".." && !subpath.startsWith("../") && !isAbsolute(subpath);
          };
          const binding = store.db.prepare("SELECT source_thread_id FROM sessions WHERE id = ?").get(session.id);
          const threadId = binding?.source_thread_id ? String(binding.source_thread_id) : session.id;
          let path = sessionPaths.get(session.id) || paths.find((file) => file.endsWith(`-${threadId}.jsonl`));
          if (!path) {
            const archived = (await listLogs(join(dirname(root), "archived_sessions"))).find((file) => file.endsWith(`-${threadId}.jsonl`));
            if (archived) {
              store.endSession(session.id, new Date().toISOString(), "explicit");
              session.status = "ended";
              path = archived;
            }
          }
          if (!path && session.pid && session.status !== "ended") {
            const files = options.openFiles ? await options.openFiles(session.pid) : await execFileAsync(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", ["-a", "-p", String(session.pid), "-Fn"], { encoding: "utf8" })
              .then((result) => result.stdout.split("\n").filter((line) => line.startsWith("n")).map((line) => line.slice(1)), () => []);
            const candidates: string[] = [];
            for (const file of new Set(files.filter((file) => file.startsWith(root + "/") && file.endsWith(".jsonl")))) {
              const candidate = await read(file);
              // 子のログも同じプロセスが開く。根の候補だけを使う。
              if (candidate && !candidate.parentThreadId && belongsToRepo(candidate) && !store.db.prepare("SELECT 1 FROM sessions WHERE id != ? AND (id = ? OR source_thread_id = ?)").get(session.id, candidate.threadId, candidate.threadId)) candidates.push(file);
            }
            if (candidates.length === 1) path = candidates[0];
          }
          if (!path && !binding?.source_thread_id && session.status !== "ended") {
            const candidates: string[] = [];
            // MCP に thread id が渡らない版では、登録直後の一意な根だけを結ぶ。
            for (const file of paths) {
              const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
              if (!info || info.mtimeMs < Date.parse(session.startedAt) - SESSION_BIND_WINDOW_MS) continue;
              const candidate = await read(file);
              if (!candidate || candidate.parentThreadId || !belongsToRepo(candidate)) continue;
              const startDifference = Math.abs(Date.parse(candidate.startedAt) - Date.parse(session.startedAt));
              if (!Number.isFinite(startDifference) || startDifference > SESSION_BIND_WINDOW_MS) continue;
              if (store.db.prepare("SELECT 1 FROM sessions WHERE id != ? AND (id = ? OR source_thread_id = ?)").get(session.id, candidate.threadId, candidate.threadId)) continue;
              candidates.push(file);
            }
            if (candidates.length === 1) path = candidates[0];
          }
          if (!path) continue;
          let snapshot = await read(path);
          if (!snapshot) {
            const archived = join(dirname(root), "archived_sessions", basename(path));
            snapshot = await read(archived);
            if (snapshot) {
              store.endSession(session.id, new Date().toISOString(), "explicit");
              session.status = "ended";
              path = archived;
            }
          }
          if (!snapshot) continue;
          if (!binding?.source_thread_id && session.id !== snapshot.threadId) {
            store.db.prepare("UPDATE sessions SET source_thread_id = ? WHERE id = ?").run(snapshot.threadId, session.id);
          }
          sessionPaths.set(session.id, path);
          const rootKey = `${session.id}:${path}`;
          const mtime = snapshots.get(path)!.mtime;
          if (applied.get(rootKey) !== mtime) { applyCodexSnapshot(store, session, snapshot); applied.set(rootKey, mtime); }
          const byThread = new Map<string, string | undefined>([[snapshot.threadId, undefined]]);
          const recent = paths.filter((file) => !file.includes("/archived_sessions/") && file.localeCompare(path!) >= 0);
          // 新しい子は小さい候補集合から探し、親の thread id が一致したものだけを結ぶ。
          for (const candidate of recent) {
            if (candidate === path) continue;
            const child = await read(candidate);
            if (!child?.parentThreadId || !byThread.has(child.parentThreadId)) continue;
            const childKey = `${session.id}:${candidate}`;
            const childMtime = snapshots.get(candidate)!.mtime;
            const id = stableId(child.threadId, "subagent");
            if (applied.get(childKey) !== childMtime) {
              applyChild(store, session, child, byThread.get(child.parentThreadId));
              applied.set(childKey, childMtime);
            }
            byThread.set(child.threadId, id);
          }
        }
      }
    } catch (error) { (options.onError || console.error)(error); }
    finally { inflight = undefined; }
  })();
  const timer = setInterval(() => { void tick(); }, options.intervalMs || POLL_MS);
  void tick();
  return { tick, stop: async () => { clearInterval(timer); await inflight; } };
}
