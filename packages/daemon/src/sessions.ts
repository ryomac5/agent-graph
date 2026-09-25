import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store, type WaitingReason } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";

const execFileAsync = promisify(execFile);

// hook が送る本文の上限。turn の応答は 6000 字、要約はその先頭 3 行。
export const REPLY_LIMIT = 6000;
export const SUMMARY_LINES = 3;
const GOAL_LIMIT = 200;
const PROMPT_LIMIT = 20_000;

export type ObserveKind = "turn_start" | "turn_done" | "waiting"
  | "subagent_request" | "subagent_start" | "subagent_message" | "subagent_stop" | "resumed";

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

export function summarize(text: string, lines = SUMMARY_LINES): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join("\n");
}

// pid は受けない。根の pid は shim の hello だけで記録する。
export async function registerSession(body: unknown, stores: Map<string, Store>): Promise<void> {
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
  if (store.db.prepare("SELECT 1 FROM events WHERE kind = 'session.started' AND session_id = ?").get(id)) return;
  const traceId = existing ? String(existing.trace_id) : newTraceId();
  if (!existing) {
    store.insertNamedSession({ id, repoKey: key, client, traceId, startedAt: ts,
      ...(typeof model === "string" && model ? { model } : {}) });
  }
  store.appendEvent({ id: ulid(), ts, kind: "session.started", repo: key, session: id,
    trace: { traceId, spanId: newSpanId() }, payload: { sessionId: id } });
}

// SessionEnd。未知のセッションは NotFoundError。すでに終わっていれば何もしない。
export function endSession(id: string, stores: Map<string, Store>, now = new Date()): void {
  const store = findStore(id, stores);
  if (!store) throw new NotFoundError(`Session not found: ${id}`);
  store.endSession(id, now.toISOString());
}

export const observers: Record<string, Observer> = {
  turn_start: (store, { sessionId, at, body }) => {
    const prompt = optionalString(body.prompt, PROMPT_LIMIT) ?? "";
    store.touchSession(sessionId, at);
    if (prompt.trim()) store.setSessionGoalIfEmpty(sessionId, prompt.trim().slice(0, GOAL_LIMIT));
    store.insertTurn({ id: ulid(), sessionId, at, prompt });
  },
  turn_done: (store, { sessionId, at, body }) => {
    const reply = optionalString(body.reply, REPLY_LIMIT) ?? "";
    const summary = optionalString(body.summary, REPLY_LIMIT) ?? summarize(reply);
    store.touchSession(sessionId, at);
    store.finishTurn(sessionId, at, summary, reply, ulid);
  },
  waiting: (store, { sessionId, at, body }) => {
    const reason = body.reason;
    if (reason !== "permission" && reason !== "question") throw new TypeError("Invalid waiting reason");
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
}
