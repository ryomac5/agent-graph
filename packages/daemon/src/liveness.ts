import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Store } from "../../core/src/store/store.ts";

const execFileAsync = promisify(execFile);

export const LIVENESS_INTERVAL_MS = 30_000;
export const STALE_SESSION_MS = 30 * 60_000;

// プロセスの起動時刻。pid の再利用と区別する鍵にする。取れなければ undefined。
export async function processStartedAt(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" } });
    const value = stdout.trim();
    return value || undefined;
  } catch { return undefined; }
}

// プロセスが同じものとして生きているか。起動時刻まで一致して初めて同じプロセスとみなす。
export async function isProcessAlive(pid: number, startedAt: string | undefined): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // 他ユーザーのプロセスは実在するので起動時刻まで確かめる
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (!startedAt) return true;
  const current = await processStartedAt(pid);
  return current === undefined || current === startedAt;
}

// 長く常駐して、多くのスレッドの親になるプロセス。pid が生きていてもセッションが生きているとは言えない
const HOST_PROCESS = /codex(-\S+)? app-server|codex-code-mode-host/;

// pid が常駐プロセスを指すか。取れなければ常駐ではないとみなす
export async function isHostProcess(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)]);
    return HOST_PROCESS.test(stdout);
  } catch { return false; }
}

export interface LivenessOptions {
  isHost?: (pid: number) => Promise<boolean>;
  now?: () => Date;
  isAlive?: (pid: number, startedAt: string | undefined) => Promise<boolean>;
  startedAtOf?: (pid: number) => Promise<string | undefined>;
  staleMs?: number;
}

// running か waiting のセッションの生死を確かめ、死んでいれば ended にする。
// pid があればプロセスの実在で、無ければ最後の記録からの経過時間で判定する。
// 起動時刻が空のまま残った pid は、生きていれば見回りで起動時刻を補い、以後の pid の再利用を見分けられるようにする。
export async function reconcileLiveness(store: Store, options: LivenessOptions = {}): Promise<string[]> {
  const now = (options.now ?? (() => new Date()))();
  const isAlive = options.isAlive ?? isProcessAlive;
  const startedAtOf = options.startedAtOf ?? processStartedAt;
  const staleMs = options.staleMs ?? STALE_SESSION_MS;
  const isHost = options.isHost ?? isHostProcess;
  const ended: string[] = [];
  for (const session of store.listLiveSessions()) {
    let dead: boolean;
    // 常駐プロセスの pid は当てにせず、pid の無いセッションと同じく最後の動きからの経過で判定する
    const trustPid = session.pid !== undefined && !(await isHost(session.pid));
    if (trustPid && session.pid !== undefined) {
      dead = !(await isAlive(session.pid, session.pidStartedAt));
      if (!dead && session.pidStartedAt === undefined) {
        const startedAt = await startedAtOf(session.pid);
        if (startedAt) store.setSessionProcess(session.id, session.pid, startedAt, session.lastSeenAt);
      }
    } else dead = now.getTime() - Date.parse(session.lastSeenAt) > staleMs;
    if (!dead) continue;
    // 理由を残す。idle で終えたものだけが次の観測で running に戻る
    const endedAt = trustPid ? now.toISOString() : session.lastSeenAt;
    if (store.endSession(session.id, endedAt, trustPid ? "process_exit" : "idle")) ended.push(session.id);
  }
  return ended;
}

export function startLivenessMonitor(stores: Map<string, Store>, options: LivenessOptions & {
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  onError?: (error: unknown) => void;
} = {}): { tick: () => Promise<void>; stop: () => Promise<void> } {
  const schedule = options.setIntervalImpl ?? setInterval;
  const clear = options.clearIntervalImpl ?? clearInterval;
  let inflight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    try {
      for (const store of stores.values()) await reconcileLiveness(store, options);
    } catch (error) { (options.onError ?? console.error)(error); }
  };
  // 前の回が終わるまで次を始めない。後始末は代入のあとに予約する。
  // run の中で await を通らずに終わると、finally の中で戻した値を ??= の代入が上書きし、二度と動かなくなっていた
  const tick = (): Promise<void> => {
    if (inflight) return inflight;
    const current = run().finally(() => { if (inflight === current) inflight = undefined; });
    inflight = current;
    return current;
  };
  const timer = schedule(() => { void tick(); }, options.intervalMs ?? LIVENESS_INTERVAL_MS);
  return { tick, stop: async () => { clear(timer); await inflight; } };
}
