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
// Claude Code のバックグラウンドセッションを抱える常駐プロセス。ターミナルを閉じても子の Claude を生かし続ける
const CLAUDE_HOST = /--bg-pty-host|claude daemon run/;

// pid が常駐プロセスを指すか、常駐プロセスに抱えられた Claude か。取れなければ常駐ではないとみなす
export async function isHostProcess(pid: number,
  ps: (pid: number) => Promise<string> = async (target) =>
    (await execFileAsync("ps", ["-o", "ppid=,command=", "-p", String(target)])).stdout): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const own = /^\s*(\d+)\s+(.*)$/s.exec(await ps(pid));
    if (!own) return false;
    if (HOST_PROCESS.test(own[2]) || CLAUDE_HOST.test(own[2])) return true;
    const parent = /^\s*\d+\s+(.*)$/s.exec(await ps(Number(own[1])));
    return !!parent && CLAUDE_HOST.test(parent[1]);
  } catch { return false; }
}

export interface LivenessOptions {
  isHost?: (pid: number) => Promise<boolean>;
  now?: () => Date;
  isAlive?: (pid: number, startedAt: string | undefined) => Promise<boolean>;
  startedAtOf?: (pid: number) => Promise<string | undefined>;
  staleMs?: number;
}

// 割れた片割れを寄せたあと、本物は pid を持たないまま放置で終わることがある。ターミナルは開いたままでも終了と出ていた。
// 片割れに残った Claude の本体の pid が起動時刻まで一致して生きていて、同じリポジトリに放置で終わった pid の無い本物が
// ちょうど 1 つなら、本物を running に戻して pid を移す
async function reviveFromGhosts(store: Store, isAlive: (pid: number, startedAt: string | undefined) => Promise<boolean>,
  isHost: (pid: number) => Promise<boolean>, at: string): Promise<void> {
  const ghosts = store.db.prepare(`SELECT repo_key, pid, pid_started_at FROM sessions WHERE client = 'claude' AND status = 'ended'
    AND ended_reason = 'explicit' AND pid IS NOT NULL AND pid_started_at IS NOT NULL AND length(id) = 26 AND id NOT LIKE '%-%'`).all();
  for (const ghost of ghosts) {
    const pid = Number(ghost.pid);
    const startedAt = String(ghost.pid_started_at);
    // 同じプロセスをすでに誰かが持っていれば済んでいる
    if (store.db.prepare("SELECT 1 FROM sessions WHERE pid = ? AND status != 'ended'").get(pid)) continue;
    if (!(await isAlive(pid, startedAt)) || await isHost(pid)) continue;
    const partners = store.db.prepare(`SELECT id FROM sessions WHERE client = 'claude' AND repo_key = ? AND status = 'ended'
      AND ended_reason = 'idle' AND pid IS NULL AND id LIKE '%-%-%-%-%'`).all(String(ghost.repo_key));
    if (partners.length !== 1) continue;
    const realId = String(partners[0].id);
    if (store.reviveIdleSession(realId, at)) store.setSessionProcess(realId, pid, startedAt, at);
  }
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
  await reviveFromGhosts(store, isAlive, isHost, now.toISOString());
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
