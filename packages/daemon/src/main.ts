#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runDelegation } from "../../core/src/delegate/run.ts";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId, parseTraceparent, parseTracestate } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";
import { readCodexUsage } from "../../core/src/usage/codex.ts";
import { probeClaudeUsage } from "../../core/src/usage/claude.ts";
import type { UsageSample } from "../../core/src/usage/types.ts";
import type { DelegateHandler } from "./mcp/server.ts";
import { runDir } from "./paths.ts";
import { startSocketServer, type Hello } from "./socket.ts";

const execFileAsync = promisify(execFile);
const CODEX_INTERVAL_MS = 60_000;
const CLAUDE_INTERVAL_MS = 300_000;
const CLAUDE_TIMEOUT_MS = 30_000;

export function startUsageProbe(stores: Map<string, Store>, options: {
  env?: NodeJS.ProcessEnv;
  readCodex?: () => UsageSample[];
  probeClaude?: (cwd: string) => Promise<UsageSample[]>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
} = {}): { stop: () => Promise<void> } {
  const env = options.env ?? process.env;
  if (env.AGENT_GRAPH_USAGE_PROBE === "0") return { stop: async () => {} };
  const schedule = options.setIntervalImpl ?? setInterval;
  const clear = options.clearIntervalImpl ?? clearInterval;
  const active = new Set<Promise<void>>();
  const sample = (provider: "openai" | "anthropic", read: () => Promise<UsageSample[]>): void => {
    if ([...active].some((task) => (task as Promise<void> & { provider?: string }).provider === provider)) return;
    const task = (async () => {
      const samples = await read();
      for (const [key, store] of stores) for (const value of samples) {
        store.appendUsageSample(value);
        const payload = { provider: value.provider, window: value.window, percent: value.percent,
          ...(value.model ? { model: value.model } : {}) };
        store.appendEvent({ id: ulid(), ts: value.ts, kind: "usage.sampled", repo: key,
          trace: { traceId: newTraceId(), spanId: newSpanId() },
          payload });
      }
    })() as Promise<void> & { provider?: string };
    task.provider = provider;
    active.add(task);
    void task.catch((error) => console.error(error)).finally(() => active.delete(task));
  };
  const codex = schedule(() => sample("openai", async () => (options.readCodex ?? readCodexUsage)()), CODEX_INTERVAL_MS);
  const claude = schedule(() => sample("anthropic", async () => {
    const cwd = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-graph", "usage-probe");
    await mkdir(cwd, { recursive: true });
    return (options.probeClaude ?? ((path) => probeClaudeUsage({ cwd: path, timeoutMs: CLAUDE_TIMEOUT_MS })))(cwd);
  }), CLAUDE_INTERVAL_MS);
  return { stop: async () => { clear(codex); clear(claude); await Promise.allSettled(active); } };
}

export function createHandler(stores: Map<string, Store>): DelegateHandler<Hello> {
  const callers = new WeakMap<Hello, { sessionId: string; traceId: string; spanId: string }>();
  return async (request, hello) => {
    const repoRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: hello.cwd })).stdout.trim();
    const key = repoKey(repoRoot);
    let store = stores.get(key);
    if (!store) {
      store = openStore(stateDbPath(key));
      store.upsertRepo({ key, rootPath: repoRoot, name: basename(repoRoot) });
      stores.set(key, store);
    }
    const state = parseTracestate(hello.tracestate);
    let caller = callers.get(hello);
    if (!caller) {
      const sessionId = state.sessionId ?? hello.session ?? ulid();
      const existing = store.db.prepare("SELECT trace_id FROM sessions WHERE id = ?").get(sessionId);
      caller = { sessionId,
        ...(parseTraceparent(hello.traceparent) ?? {
          traceId: existing ? String(existing.trace_id) : newTraceId(), spanId: newSpanId(),
        }) };
      callers.set(hello, caller);
    }
    const session = store.db.prepare("SELECT trace_id FROM sessions WHERE id = ?").get(caller.sessionId);
    if (session && session.trace_id !== caller.traceId) throw new Error("Session trace does not match hello");
    if (!session) store.insertSession({ id: caller.sessionId, repoKey: key, name: caller.sessionId,
      client: "mcp", traceId: caller.traceId, startedAt: new Date().toISOString() });
    return runDelegation(request, { repoKey: key, repoRoot, sessionId: caller.sessionId,
      trace: { traceId: caller.traceId, spanId: caller.spanId, traceState: hello.tracestate },
      parentDelegationId: state.delegationId }, { store });
  };
}

async function claimPid(path: string): Promise<void> {
  for (;;) {
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let value;
      try { value = await readFile(path, "utf8"); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      const pid = Number(value.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid daemon PID file: ${path}`);
      try {
        process.kill(pid, 0);
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
        try { await unlink(path); }
        catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      throw new Error(`Daemon is already running (pid ${pid})`);
    }
    await file.writeFile(`${process.pid}\n`);
    await file.close();
    return;
  }
}

export async function startDaemon(): Promise<{ stop: () => Promise<void> }> {
  const dir = runDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pidPath = join(dir, "daemon.pid");
  const logPath = join(dir, "daemon.log");
  const log = (message: string): void => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  await claimPid(pidPath);
  const stores = new Map<string, Store>();
  const usageProbe = startUsageProbe(stores);
  const handler = createHandler(stores);
  const pending = new Set<Promise<unknown>>();
  try {
    const server = await startSocketServer({ socketPath: process.env.AGENT_GRAPH_SOCKET || join(dir, "daemon.sock"),
      handler: async (request, hello) => {
        const result = handler(request, hello);
        pending.add(result);
        try {
          const value = await result;
          log(JSON.stringify(value));
          return value;
        } catch (error) {
          log(String(error));
          throw error;
        } finally { pending.delete(result); }
      } });
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => stopping ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
      await Promise.allSettled(pending);
      await usageProbe.stop();
      for (const store of stores.values()) store.close();
      await unlink(pidPath);
      log("stopped");
    })();
    log(`started pid=${process.pid}`);
    return { stop };
  } catch (error) {
    log(String(error));
    await usageProbe.stop();
    for (const store of stores.values()) store.close();
    await unlink(pidPath);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startDaemon().then(({ stop }) => {
    const shutdown = (): void => { void stop().catch((error) => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
