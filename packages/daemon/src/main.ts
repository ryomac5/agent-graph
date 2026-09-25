#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runDelegation } from "../../core/src/delegate/run.ts";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId, parseTraceparent, parseTracestate } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";
import type { DelegateHandler } from "./mcp/server.ts";
import { runDir } from "./paths.ts";
import { startSocketServer, type Hello } from "./socket.ts";

const execFileAsync = promisify(execFile);

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
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const value = await readFile(path, "utf8");
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid daemon PID file: ${path}`);
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      // 同時起動時に他プロセスが取得した PID ファイルを消さない。
      throw new Error(`Stale daemon PID file; remove it before restarting: ${path}`);
    }
    throw new Error(`Daemon is already running (pid ${pid})`);
  }
  await file.writeFile(`${process.pid}\n`);
  await file.close();
  return;
}

export async function startDaemon(): Promise<{ stop: () => Promise<void> }> {
  const dir = runDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pidPath = join(dir, "daemon.pid");
  const logPath = join(dir, "daemon.log");
  const log = (message: string): void => appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  await claimPid(pidPath);
  const stores = new Map<string, Store>();
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
      for (const store of stores.values()) store.close();
      await unlink(pidPath);
      log("stopped");
    })();
    log(`started pid=${process.pid}`);
    return { stop };
  } catch (error) {
    log(String(error));
    for (const store of stores.values()) store.close();
    await unlink(pidPath);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startDaemon().then(({ stop }) => {
    const shutdown = (): void => { void stop().catch((error) => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
