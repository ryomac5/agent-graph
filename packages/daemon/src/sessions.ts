import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, UNNAMED, type Store, type WaitingReason } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";

const execFileAsync = promisify(execFile);

// hook が送る本文の上限。turn の応答は 6000 字、要約はその先頭 3 行。
export const REPLY_LIMIT = 6000;
export const SUMMARY_LINES = 3;
const GOAL_LIMIT = 200;
const PROMPT_LIMIT = 20_000;

export type ObserveKind = "turn_start" | "turn_done" | "waiting"
  | "subagent_request" | "subagent_done" | "subagent_start" | "subagent_message" | "subagent_stop" | "resumed";

export interface ObserveInput {
  kind: ObserveKind;
  sessionId: string;
  at: string;
  body: Record<string, unknown>;
}

// 観測の種類ごとの取り込み。サブエージェントの種類は observe.ts が足す。
export type Observer = (store: Store, input: ObserveInput) => void;

export class NotFoundError extends Error {}

function findStore(id: string, stores: Map<string, Store>): Store | undefined {
  for (const store of stores.values()) {
    if (store.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) return store;
  }
  return undefined;
}

function optionalString(value: unknown, limit: number): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

// 人の指示か。空、タグだけ、task-notification を含むもの、引数の無いスラッシュコマンドは人の指示としない
export function isHumanPrompt(prompt: unknown): boolean {
  if (typeof prompt !== "string" || prompt.includes("<task-notification>")) return false;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(prompt)?.[1]?.trim();
  if (args) return true;
  const text = prompt.replace(/<([A-Za-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "").trim();
  return text !== "" && !/^\/[\w:.-]+$/.test(text);
}

// --fork-session と --resume を持つ Claude の起動行から親のセッション id を取る。--resume は id か履歴の JSONL の道を取る
export function forkParentOf(command: string): string | undefined {
  if (!/(?:^|\s)--fork-session(?=\s|$)/.test(command)) return undefined;
  return /(?:^|\s)(?:--resume|-r)(?:=|\s+)\S*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?(?=\s|$)/i
    .exec(command)?.[1];
}

export type ReadCommand = (pid: number) => Promise<string>;
const readCommand: ReadCommand = async (pid) => (await execFileAsync("ps", ["-o", "command=", "-p", String(pid)])).stdout;

// 番号のないセッションが fork なら、親を session.forked に残す。番号は最初の人の指示で親から継ぐ
export async function noteForkParent(store: Store, sessionId: string, pid: unknown, at: string,
  read: ReadCommand = readCommand): Promise<void> {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return;
  const before = store.db.prepare("SELECT name FROM sessions WHERE id = ?").get(sessionId);
  if (!before || before.name !== UNNAMED) return;
  if (store.db.prepare("SELECT 1 FROM events WHERE kind = 'session.forked' AND session_id = ?").get(sessionId)) return;
  let command: string;
  try { command = await read(pid); } catch { return; }
  const parentSessionId = forkParentOf(command);
  if (!parentSessionId || parentSessionId === sessionId) return;
  const session = store.db.prepare("SELECT name, repo_key, trace_id FROM sessions WHERE id = ?").get(sessionId);
  if (!session || session.name !== UNNAMED) return;
  if (store.db.prepare("SELECT 1 FROM events WHERE kind = 'session.forked' AND session_id = ?").get(sessionId)) return;
  store.appendEvent({ id: ulid(), ts: at, kind: "session.forked", repo: String(session.repo_key), session: sessionId,
    trace: { traceId: String(session.trace_id), spanId: newSpanId() }, payload: { sessionId, parentSessionId } });
}

export function summarize(text: string, lines = SUMMARY_LINES): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join("\n");
}

// pid は受けない。根の pid は shim の hello だけで記録する。
// hook が送った Claude の本体の pid を本物のセッションに付け、同じ Claude から割れた片割れを寄せる。
// 片割れは shim が Claude の id を知らなかった頃に作られた ULID のセッションで、同じ pid を持つ
export function adoptClaudeProcess(store: Store, sessionId: string, claudePid: unknown, at: string): void {
  if (typeof claudePid !== "number" || !Number.isSafeInteger(claudePid) || claudePid <= 1) return;
  const session = store.db.prepare("SELECT client, pid, status FROM sessions WHERE id = ?").get(sessionId);
  if (!session || session.client !== "claude" || session.status === "ended") return;
  if (session.pid === null || session.pid === undefined) store.setSessionProcess(sessionId, claudePid, undefined, at);
  const ghosts = store.db.prepare(`SELECT id FROM sessions WHERE client = 'claude' AND pid = ? AND id != ?
    AND status != 'ended' AND length(id) = 26 AND id NOT LIKE '%-%'`).all(claudePid, sessionId);
  for (const ghost of ghosts) store.mergeSessionInto(String(ghost.id), sessionId, at);
}

export async function registerSession(body: unknown, stores: Map<string, Store>, read: ReadCommand = readCommand): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Invalid session body");
  const { id, cwd, client, model } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || id.includes("\0") ||
      typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0") ||
      (client !== "claude" && client !== "codex" && client !== "planner") ||
      (model !== undefined && typeof model !== "string")) throw new TypeError("Invalid session body");
  let root: string;
  try {
    root = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
  } catch { throw new TypeError("cwd must be an existing git working directory"); }
  const key = repoKey(root);
  let store = stores.get(key);
  if (!store) {
    store = openStore(stateDbPath(key));
    store.upsertRepo({ key, rootPath: root, name: basename(root) });
    stores.set(key, store);
  }
  const existing = store.db.prepare("SELECT client, trace_id FROM sessions WHERE id = ?").get(id);
  if (existing && existing.client !== client) throw new TypeError("Session client does not match");
  const ts = new Date().toISOString();
  // claude --resume などで同じ id が戻ってきたら running に戻す
  if (existing) store.resumeSession(id, ts);
  if (typeof model === "string" && model) store.setSessionModel(id, model);
  // hook の再送や MCP による先行登録でも、開始イベントは一度だけ記録する。
  const claudePid = (body as Record<string, unknown>).claudePid;
  if (store.db.prepare("SELECT 1 FROM events WHERE kind = 'session.started' AND session_id = ?").get(id)) {
    adoptClaudeProcess(store, id, claudePid, ts);
    await noteForkParent(store, id, claudePid, ts, read);
    return;
  }
  const traceId = existing ? String(existing.trace_id) : newTraceId();
  // 番号はまだ付けない。最初の人の指示で付ける
  if (!existing) {
    store.insertUnnamedSession({ id, repoKey: key, client, traceId, startedAt: ts,
      ...(typeof model === "string" && model ? { model } : {}) });
  }
  store.appendEvent({ id: ulid(), ts, kind: "session.started", repo: key, session: id,
    trace: { traceId, spanId: newSpanId() }, payload: { sessionId: id } });
  adoptClaudeProcess(store, id, claudePid, ts);
  await noteForkParent(store, id, claudePid, ts, read);
}

// SessionEnd。未知のセッションは NotFoundError。すでに終わっていれば何もしない。
export function endSession(id: string, stores: Map<string, Store>, now = new Date()): void {
  const store = findStore(id, stores);
  if (!store) throw new NotFoundError(`Session not found: ${id}`);
  store.endSession(id, now.toISOString(), "explicit");
}

// 観測の前に、pid を持たないまま 30 分の規則で ended にしたセッションだけを running に戻す。
// pid の死で ended にしたものと hook や操作で終えたものは戻さない。
function reviveIfIdle(store: Store, sessionId: string, at: string): void {
  store.reviveIdleSession(sessionId, at);
}

export const observers: Record<string, Observer> = {
  turn_start: (store, { sessionId, at, body }) => {
    const prompt = optionalString(body.prompt, PROMPT_LIMIT) ?? "";
    reviveIfIdle(store, sessionId, at);
    store.touchSession(sessionId, at);
    if (prompt.trim()) store.setSessionGoalIfEmpty(sessionId, prompt.trim().slice(0, GOAL_LIMIT));
    store.insertTurn({ id: ulid(), sessionId, at, prompt });
    // 無人実行の子は人の指示を受けないので番号を取らない
    if (body.headless !== true && isHumanPrompt(prompt)) store.nameSessionAtFirstPrompt(sessionId, at);
  },
  turn_done: (store, { sessionId, at, body }) => {
    const reply = optionalString(body.reply, REPLY_LIMIT) ?? "";
    const summary = optionalString(body.summary, REPLY_LIMIT) ?? summarize(reply);
    reviveIfIdle(store, sessionId, at);
    store.touchSession(sessionId, at);
    store.finishTurn(sessionId, at, summary, reply, ulid);
  },
  waiting: (store, { sessionId, at, body }) => {
    const reason = body.reason;
    if (reason !== "permission" && reason !== "question") throw new TypeError("Invalid waiting reason");
    reviveIfIdle(store, sessionId, at);
    store.setSessionWaiting(sessionId, reason as WaitingReason, at);
  },
};

// POST /api/observe の本文を取り込む。不正な body は TypeError、未知のセッションは NotFoundError。
// table は観測の種類の表。observe.ts がサブエージェントの種類を足した表を渡す。
export function observe(body: unknown, stores: Map<string, Store>, now = new Date(), table: Record<string, Observer> = observers): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Invalid observe body");
  const { kind, sessionId } = body as Record<string, unknown>;
  if (typeof kind !== "string" || !Object.hasOwn(table, kind)) throw new TypeError(`Unknown observe kind: ${String(kind)}`);
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new TypeError("Invalid observe body");
  const store = findStore(sessionId, stores);
  if (!store) throw new NotFoundError(`Session not found: ${sessionId}`);
  table[kind](store, { kind: kind as ObserveKind, sessionId, at: now.toISOString(), body: body as Record<string, unknown> });
  adoptClaudeProcess(store, sessionId, (body as Record<string, unknown>).claudePid, now.toISOString());
}
