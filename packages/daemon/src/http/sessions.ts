import { execFile } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { repoKey, stateDbPath } from "../../../core/src/paths.ts";
import { openStore, type Store } from "../../../core/src/store/store.ts";
import { newSpanId, newTraceId } from "../../../core/src/trace.ts";
import { ulid } from "../../../core/src/ulid.ts";

const execFileAsync = promisify(execFile);

export async function registerSession(body: unknown, stores: Map<string, Store>): Promise<void> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Invalid session body");
  const { id, cwd, client } = body as Record<string, unknown>;
  if (typeof id !== "string" || !id.trim() || id.includes("\0") ||
      typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0") ||
      (client !== "claude" && client !== "codex" && client !== "planner")) throw new TypeError("Invalid session body");
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
  // hook の再送や MCP による先行登録でも、開始イベントは一度だけ記録する。
  if (store.db.prepare("SELECT 1 FROM events WHERE kind = 'session.started' AND session_id = ?").get(id)) return;
  const traceId = existing ? String(existing.trace_id) : newTraceId();
  const ts = new Date().toISOString();
  if (!existing) store.insertSession({ id, repoKey: key, name: id, client, traceId, startedAt: ts });
  store.appendEvent({ id: ulid(), ts, kind: "session.started", repo: key, session: id,
    trace: { traceId, spanId: newSpanId() }, payload: { sessionId: id } });
}
