#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runDelegation } from "../../core/src/delegate/run.ts";
import type { DelegateResult } from "../../core/src/delegate/types.ts";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { newSpanId, newTraceId, parseTraceparent, parseTracestate } from "../../core/src/trace.ts";
import { ulid } from "../../core/src/ulid.ts";
import { readCodexUsage } from "../../core/src/usage/codex.ts";
import { probeClaudeUsage } from "../../core/src/usage/claude.ts";
import type { UsageSample } from "../../core/src/usage/types.ts";
import type { DelegateHandler } from "./mcp/server.ts";
import { runDir } from "./paths.ts";
import { readDashboardPort } from "./config.ts";
import { startHttpServer } from "./http/server.ts";
import { processStartedAt, startLivenessMonitor } from "./liveness.ts";
import { startSocketServer, type Hello } from "./socket.ts";

const execFileAsync = promisify(execFile);
const CODEX_INTERVAL_MS = 60_000;
const CLAUDE_INTERVAL_MS = 300_000;
const CLAUDE_TIMEOUT_MS = 30_000;

function saveUsage(store: Store, repo: string, value: UsageSample): void {
  store.appendUsageSample(value);
  store.appendEvent({ id: ulid(), ts: value.ts, kind: "usage.sampled", repo,
    trace: { traceId: newTraceId(), spanId: newSpanId() },
    payload: { provider: value.provider, window: value.window, percent: value.percent,
      ...(value.model ? { model: value.model } : {}) } });
}

export function startUsageProbe(stores: Map<string, Store>, options: {
  env?: NodeJS.ProcessEnv;
  readCodex?: () => UsageSample[];
  probeClaude?: (cwd: string) => Promise<UsageSample[]>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  latest?: Map<string, UsageSample>;
} = {}): { stop: () => Promise<void> } {
  const env = options.env ?? process.env;
  if (env.AGENT_GRAPH_USAGE_PROBE === "0") return { stop: async () => {} };
  const schedule = options.setIntervalImpl ?? setInterval;
  const clear = options.clearIntervalImpl ?? clearInterval;
  const inflight = new Map<"openai" | "anthropic", Promise<void>>();
  const latest = options.latest;
  const sample = (provider: "openai" | "anthropic", read: () => Promise<UsageSample[]>): void => {
    if (inflight.has(provider)) return;
    const task = (async () => {
      const samples = await read();
      for (const value of samples) {
        const sampleKey = `${value.provider}\0${value.model ?? ""}\0${value.window}`;
        const previous = latest?.get(sampleKey);
        if (!previous || value.ts > previous.ts) latest?.set(sampleKey, value);
        for (const [key, store] of stores) saveUsage(store, key, value);
      }
    })();
    inflight.set(provider, task);
    void task.catch((error) => console.error(error)).finally(() => inflight.delete(provider));
  };
  const codex = schedule(() => sample("openai", async () => (options.readCodex ?? readCodexUsage)()), CODEX_INTERVAL_MS);
  const claude = schedule(() => sample("anthropic", async () => {
    const cwd = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-graph", "usage-probe");
    await mkdir(cwd, { recursive: true });
    return (options.probeClaude ?? ((path) => probeClaudeUsage({ cwd: path, timeoutMs: CLAUDE_TIMEOUT_MS })))(cwd);
  }), CLAUDE_INTERVAL_MS);
  return { stop: async () => { clear(codex); clear(claude); await Promise.allSettled(inflight.values()); } };
}

export function createHandler(stores: Map<string, Store>, latest = new Map<string, UsageSample>()): DelegateHandler<Hello, DelegateResult> {
  const callers = new WeakMap<Hello, { sessionId: string; traceId: string; spanId: string }>();
  return async (request, hello) => {
    const repoRoot = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: hello.cwd })).stdout.trim();
    const key = repoKey(repoRoot);
    let store = stores.get(key);
    if (!store) {
      store = openStore(stateDbPath(key));
      store.upsertRepo({ key, rootPath: repoRoot, name: basename(repoRoot) });
      for (const value of latest.values()) saveUsage(store, key, value);
      stores.set(key, store);
    }
    const state = parseTracestate(hello.tracestate);
    let caller = callers.get(hello);
    const firstRequest = !caller;
    if (!caller) {
      const sessionId = state.sessionId ?? hello.session ?? ulid();
      const existing = store.db.prepare("SELECT trace_id FROM sessions WHERE id = ?").get(sessionId);
      caller = { sessionId,
        ...(parseTraceparent(hello.traceparent) ?? {
          traceId: existing ? String(existing.trace_id) : newTraceId(), spanId: newSpanId(),
        }) };
      callers.set(hello, caller);
    }
    // 根の pid と起動時刻は生死判定に使う。委譲の子からの hello では親の記録を上書きしない。
    const rootHello = !state.delegationId;
    // 起動時刻の取得は await を挟む。同じ hello の並行した要求が片方の挿入を見落とさないよう、セッションの読み取りはこの後で行う。
    const pidStartedAt = rootHello && firstRequest ? await processStartedAt(hello.pid) : undefined;
    const session = store.db.prepare("SELECT trace_id FROM sessions WHERE id = ?").get(caller.sessionId);
    if (session && session.trace_id !== caller.traceId) throw new Error("Session trace does not match hello");
    const now = new Date().toISOString();
    if (!session) store.insertNamedSession({ id: caller.sessionId, repoKey: key,
      client: hello.client ?? "mcp", traceId: caller.traceId, startedAt: now,
      ...(rootHello ? { pid: hello.pid, pidStartedAt } : {}) });
    else if (rootHello && firstRequest) {
      // 終了済みのセッションが同じ id で戻ってきたら running に戻す
      store.resumeSession(caller.sessionId, now);
      store.setSessionProcess(caller.sessionId, hello.pid, pidStartedAt, now);
    }
    else if (rootHello) store.touchSession(caller.sessionId, now);
    if (session && hello.client && rootHello) store.updateSessionClient(caller.sessionId, hello.client);
    return runDelegation(request, { repoKey: key, repoRoot, sessionId: caller.sessionId,
      trace: { traceId: caller.traceId, spanId: caller.spanId, traceState: hello.tracestate },
      parentDelegationId: state.delegationId }, { store, usageSamples: [...latest.values()] });
  };
}

// 状態置き場にある全リポジトリの store を開く。開けなかったものは例外を返し、起動は止めない。
export function openAllStores(stores: Map<string, Store>, env: NodeJS.ProcessEnv = process.env): Error[] {
  const errors: Error[] = [];
  let keys: string[];
  try { keys = readdirSync(dirname(dirname(stateDbPath("probe", env))), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return errors;
    return [error as Error];
  }
  for (const key of keys) {
    if (stores.has(key)) continue;
    let path: string;
    try { path = stateDbPath(key, env); } catch { continue; }
    if (!existsSync(path)) continue;
    try { stores.set(key, openStore(path)); }
    catch (error) { errors.push(error as Error); }
  }
  return errors;
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
  const latest = new Map<string, UsageSample>();
  const usageProbe = startUsageProbe(stores, { latest });
  const liveness = startLivenessMonitor(stores, { onError: (error) => log(String(error)) });
  const handler = createHandler(stores, latest);
  const pending = new Set<Promise<unknown>>();
  let http: Awaited<ReturnType<typeof startHttpServer>> | undefined;
  try {
    // 再起動のあとも、状態置き場にある全リポジトリを見回りの対象にする
    for (const error of openAllStores(stores)) log(String(error));
    const repoRoot = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd() })
      .then(({ stdout }) => stdout.trim(), () => undefined);
    if (repoRoot) {
      const key = repoKey(repoRoot);
      const store = stores.get(key) ?? openStore(stateDbPath(key));
      store.upsertRepo({ key, rootPath: repoRoot, name: basename(repoRoot) });
      stores.set(key, store);
    }
    http = await startHttpServer({ port: readDashboardPort(), openStores: stores,
      listRepos: () => [...stores.values()].flatMap((value) => value.db.prepare("SELECT key, root_path AS rootPath, name FROM repos").all()
        .map((row) => ({ key: String(row.key), rootPath: String(row.rootPath), name: String(row.name) }))),
      staticDir: fileURLToPath(new URL("../../dashboard/public/", import.meta.url)) });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("HTTP address unavailable");
    log(`dashboard http://127.0.0.1:${address.port}/`);
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
      http!.closeAllConnections();
      await new Promise<void>((resolve) => http!.close(() => resolve()));
      await usageProbe.stop();
      await liveness.stop();
      for (const store of stores.values()) store.close();
      await unlink(pidPath);
      log("stopped");
    })();
    log(`started pid=${process.pid}`);
    return { stop };
  } catch (error) {
    log(String(error));
    if (http) {
      const server = http;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await usageProbe.stop();
    await liveness.stop();
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
