import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { JsonValue } from "../../../core/src/ledger/facts.ts";

export const SEND_TIMEOUT_MS = 500;
export const FLUSH_BUDGET_MS = 1000;
const INPUT_REJECTIONS = new Set([400, 409, 413]);

export interface HookEvent {
  version: 1;
  session_id: string;
  generation: number;
  event_id: string;
  hook_event_name: string;
  source_ts: string;
  input: { [key: string]: JsonValue };
  managed: boolean;
  run_id?: string;
}
export interface HookDestination { url: string; token: string }
export interface HookSenderOptions {
  outbox?: string;
  destination?: HookDestination;
  destinationFile?: string;
  timeoutMs?: number;
  budgetMs?: number;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export function resolveHookOutbox(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  if (!isAbsolute(state)) throw new TypeError("State directory must be an absolute path");
  return join(state, "agent-graph", "outbox");
}

export function createHookEvent(input: HookEvent["input"], env: NodeJS.ProcessEnv = process.env): HookEvent {
  const generation = Number(input.generation ?? env.AGENT_GRAPH_GENERATION);
  if (typeof input.session_id !== "string" || !input.session_id
    || typeof input.hook_event_name !== "string" || !input.hook_event_name
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new TypeError("Hook requires session_id, hook_event_name and a positive generation");
  }
  const managed = Boolean(env.AGENT_GRAPH_MANAGED);
  const runId = env.AGENT_GRAPH_RUN_ID;
  return { version: 1, session_id: input.session_id, generation,
    event_id: typeof input.event_id === "string" && input.event_id ? input.event_id : randomUUID(),
    hook_event_name: input.hook_event_name, source_ts: typeof input.source_ts === "string"
      ? input.source_ts : new Date().toISOString(),
    input: { ...input, ...(env.CLAUDE_CODE_ENTRYPOINT ? { entrypoint: env.CLAUDE_CODE_ENTRYPOINT } : {}) },
    managed, ...(runId ? { run_id: runId } : {}) };
}

export async function resolveHookGeneration(
  input: HookEvent["input"], outbox = resolveHookOutbox(), env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const explicit = input.generation ?? env.AGENT_GRAPH_GENERATION;
  if (explicit !== undefined) return Number(explicit);
  if (typeof input.session_id !== "string" || !input.session_id) throw new TypeError("Missing session_id");
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  const id = createHash("sha256").update(input.session_id).digest("hex");
  const path = join(outbox, `.${id}.generation`);
  let previous = 0;
  try { previous = Number(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const startsGeneration = input.hook_event_name === "SessionStart"
    && (input.source === "startup" || input.source === "resume");
  if (previous && !startsGeneration) return previous;
  // API の再起動に依存せず、hook の別プロセス間でも同じ世代を共有する。
  const generation = Math.max(Date.now(), previous + 1);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(String(generation)); await file.sync(); } finally { await file.close(); }
  try {
    if (startsGeneration) await rename(temporary, path);
    else {
      try { await link(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(outbox);
  return Number(await readFile(path, "utf8"));
}

export async function enqueueHook(event: HookEvent, outbox = resolveHookOutbox()): Promise<string> {
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  const id = createHash("sha256").update(JSON.stringify([event.session_id, event.generation, event.event_id])).digest("hex");
  const path = join(outbox, `${id}.json`);
  const temporary = join(outbox, `.${id}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(event));
    await file.sync();
  } finally {
    await file.close();
  }
  // 再送側は完成した .json だけ読む。途中で停止しても部分ファイルを送らない。
  try {
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await readFile(path, "utf8") !== JSON.stringify(event)) throw new Error("Hook event ID already has different content");
    }
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(outbox);
  return path;
}

async function resolveDestination(options: HookSenderOptions): Promise<HookDestination | undefined> {
  if (options.destination) return options.destination;
  if (options.destinationFile) return JSON.parse(await readFile(options.destinationFile, "utf8"));
  if (process.env.AGENT_GRAPH_HOOK_URL && process.env.AGENT_GRAPH_HOOK_TOKEN) {
    return { url: process.env.AGENT_GRAPH_HOOK_URL, token: process.env.AGENT_GRAPH_HOOK_TOKEN };
  }
  return undefined;
}

export async function flushHookOutbox(options: HookSenderOptions = {}): Promise<number> {
  const outbox = options.outbox ?? resolveHookOutbox();
  const deadline = performance.now() + (options.budgetMs ?? FLUSH_BUDGET_MS);
  let sent = 0;
  let destination: HookDestination | undefined;
  let files: string[];
  try {
    destination = await resolveDestination(options);
    if (!destination) return sent;
    const url = new URL(destination.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) return sent;
    files = (await readdir(outbox)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  } catch { return sent; }
  for (const name of files) {
    if (performance.now() >= deadline) break;
    try {
      const path = join(outbox, name);
      const event: HookEvent = JSON.parse(await readFile(path, "utf8"));
      const body = JSON.stringify(event);
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) break;
      const response = await fetch(destination.url, { method: "POST", redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${destination.token}` },
        body, signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? SEND_TIMEOUT_MS, remaining)) });
      if (INPUT_REJECTIONS.has(response.status)) {
        await response.body?.cancel();
        // 拒否された出来事も受理までは残す。後続の送信は妨げない。
        continue;
      }
      const ack = await response.json() as Record<string, unknown>;
      if (!response.ok || ack.accepted !== true || ack.event_id !== event.event_id
        || ack.generation !== event.generation || ack.session_id !== event.session_id) break;
      await rm(path, { force: true });
      sent += 1;
    } catch {
      // 不在、タイムアウト、並行の再送では待ちを残し、次の起動で再試行する。
      break;
    }
  }
  return sent;
}

export async function sendHook(event: HookEvent, options: HookSenderOptions = {}): Promise<number> {
  await enqueueHook(event, options.outbox ?? resolveHookOutbox());
  return flushHookOutbox(options);
}
