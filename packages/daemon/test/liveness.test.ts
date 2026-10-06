import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { isHostProcess, isProcessAlive, processStartedAt, reconcileLiveness, startLivenessMonitor } from "../src/liveness.ts";

const ts = "2026-09-25T00:00:00.000Z";

function fixture(t: { after: (fn: () => void) => void }): Store {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.upsertRepo({ key: "r", rootPath: "/work/repo", name: "repo" });
  return store;
}

test("pid が死んでいれば ended にし、その委譲を lost にする。生きていれば触らない", async (t) => {
  const store = fixture(t);
  const base = { repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts };
  store.insertNamedSession({ id: "dead", ...base, pid: 11, pidStartedAt: "x" });
  store.insertNamedSession({ id: "alive", ...base, pid: 22 });
  store.insertNamedSession({ id: "waiting", ...base, pid: 33, status: "waiting", waitingReason: "permission" });
  store.insertDelegation({ id: "d1", repoKey: "r", sessionId: "dead", role: "implement", title: "d1", status: "running" });
  store.insertDelegation({ id: "d2", repoKey: "r", sessionId: "alive", role: "implement", title: "d2", status: "running" });
  const seen: [number, string | undefined][] = [];
  const now = new Date("2026-09-25T00:10:00.000Z");
  const ended = await reconcileLiveness(store, { now: () => now, isAlive: async (pid, startedAt) => { seen.push([pid, startedAt]); return pid === 22; } });
  assert.deepEqual(ended.sort(), ["dead", "waiting"]);
  assert.deepEqual(seen.sort((a, b) => a[0] - b[0]), [[11, "x"], [22, undefined], [33, undefined]]);
  const dead = store.getSession("dead")!;
  assert.equal(dead.status, "ended");
  assert.equal(dead.endedAt, now.toISOString());
  assert.equal(dead.endedReason, "process_exit");
  assert.equal(store.getSession("alive")?.status, "running");
  assert.equal(store.getSession("waiting")?.status, "ended");
  const status = (id: string) => store.db.prepare("SELECT status FROM delegations WHERE id = ?").get(id)!.status;
  assert.equal(status("d1"), "lost");
  assert.equal(status("d2"), "running");
  assert.deepEqual(await reconcileLiveness(store, { now: () => now, isAlive: async () => true }), []);
});

test("起動時刻が空の pid は、生きていれば見回りで起動時刻を補う", async (t) => {
  const store = fixture(t);
  store.insertNamedSession({ id: "s", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts, pid: 44,
    lastSeenAt: "2026-09-25T00:05:00.000Z" });
  const asked: number[] = [];
  await reconcileLiveness(store, { isAlive: async () => true, startedAtOf: async (pid) => { asked.push(pid); return undefined; } });
  assert.equal(store.getSession("s")?.pidStartedAt, undefined);
  await reconcileLiveness(store, { isAlive: async () => true, startedAtOf: async (pid) => { asked.push(pid); return "start"; } });
  const session = store.getSession("s")!;
  assert.equal(session.pidStartedAt, "start");
  assert.equal(session.lastSeenAt, "2026-09-25T00:05:00.000Z", "見回りは last_seen_at を進めない");
  await reconcileLiveness(store, { isAlive: async () => true, startedAtOf: async (pid) => { asked.push(pid); return "again"; } });
  assert.equal(store.getSession("s")?.pidStartedAt, "start");
  assert.deepEqual(asked, [44, 44]);
});

test("pid の無いセッションは 30 分記録が無ければ最後の記録の時刻で ended にする", async (t) => {
  const store = fixture(t);
  const base = { repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts };
  store.insertNamedSession({ id: "stale", ...base });
  store.insertNamedSession({ id: "fresh", ...base, lastSeenAt: "2026-09-25T00:20:00.000Z" });
  const now = new Date("2026-09-25T00:40:00.000Z");
  assert.deepEqual(await reconcileLiveness(store, { now: () => now, isAlive: async () => { throw new Error("pid は問わない"); } }), ["stale"]);
  assert.equal(store.getSession("stale")?.endedAt, ts);
  assert.equal(store.getSession("stale")?.endedReason, "idle");
  assert.equal(store.getSession("fresh")?.status, "running");
  assert.deepEqual(await reconcileLiveness(store, { now: () => new Date("2026-09-25T00:51:00.000Z") }), ["fresh"]);
});

test("実プロセスの生死。終了した子は起動時刻付きでも死と判定し、自分は生きている", { timeout: 15_000 }, async () => {
  assert.equal(await isProcessAlive(process.pid, undefined), true);
  const started = await processStartedAt(process.pid);
  assert.ok(started);
  assert.equal(await isProcessAlive(process.pid, started), true);
  assert.equal(await isProcessAlive(process.pid, "Thu Jan  1 00:00:00 1970"), false);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const childStarted = await processStartedAt(pid);
  assert.equal(await isProcessAlive(pid, childStarted), true);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await isProcessAlive(pid, childStarted), false);
  assert.equal(await isProcessAlive(0, undefined), false);
});

test("見回りは指定の間隔で全 store を確かめ、stop で止まる", async (t) => {
  const store = fixture(t);
  store.insertNamedSession({ id: "s", repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts, pid: 99 });
  let callback: (() => void) | undefined;
  let interval = 0;
  let cleared = false;
  const monitor = startLivenessMonitor(new Map([["r", store]]), {
    isAlive: async () => false,
    setIntervalImpl: ((fn: () => void, ms: number) => { callback = fn; interval = ms; return 1 as unknown as NodeJS.Timeout; }) as typeof setInterval,
    clearIntervalImpl: (() => { cleared = true; }) as typeof clearInterval,
  });
  assert.equal(interval, 30_000);
  callback!();
  await monitor.tick();
  assert.equal(store.getSession("s")?.status, "ended");
  await monitor.stop();
  assert.equal(cleared, true);
});

test("pid が常駐プロセスを指すセッションは pid を当てにせず、最後の動きからの経過で終える", async (t) => {
  const store = fixture(t);
  const base = { repoKey: "r", client: "codex", traceId: "a".repeat(32), startedAt: ts };
  // codex app-server を親に持つスレッド。app-server は生き続けるので pid では終わりを判定できない
  store.insertNamedSession({ id: "stale-host", ...base, pid: 19173 });
  store.insertNamedSession({ id: "fresh-host", ...base, pid: 19174 });
  store.markSessionSeen("fresh-host", "2026-09-25T00:50:00.000Z");
  store.insertNamedSession({ id: "terminal", ...base, pid: 22 });
  const now = new Date("2026-09-25T01:00:00.000Z");
  const ended = await reconcileLiveness(store, { now: () => now, isAlive: async () => true,
    isHost: async (pid) => pid === 19173 || pid === 19174 });
  assert.deepEqual(ended, ["stale-host"]);
  assert.equal(store.getSession("stale-host")?.endedReason, "idle");
  assert.equal(store.getSession("fresh-host")?.status, "running");
  assert.equal(store.getSession("terminal")?.status, "running");
});

test("常駐の判定は、codex app-server と Claude のバックグラウンドセッションを常駐とし、ターミナルの Claude は常駐としない", async () => {
  const table = new Map<number, string>([
    [88265, "88240 /Users/r/.local/share/claude/versions/2.1.291 --resume /x/5783bf92.jsonl"],
    [88240, "88026 /Users/r/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc-daemon/pty.sock 90"],
    [87592, "3051 claude -c"],
    [3051, "3046 -zsh"],
    [19173, "25610 /Users/r/.codex/bin/codex app-server --listen unix"],
    // ChatGPT アプリの Codex。codex と app-server のあいだに設定が挟まる
    [77447, "84436 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled -c plugins.x.enabled=true"],
    [70001, "3051 codex -c model=gpt-6.1-sol"],
    [70002, "3051 /Users/r/.nodebrew/current/bin/node /Users/r/.nodebrew/current/bin/codex exec --json 調べて"],
  ]);
  const ps = async (pid: number) => { const line = table.get(pid); if (!line) throw new Error("no such process"); return line; };
  assert.equal(await isHostProcess(88265, ps), true);
  assert.equal(await isHostProcess(19173, ps), true);
  assert.equal(await isHostProcess(77447, ps), true, "設定が挟まった app-server も常駐とする");
  assert.equal(await isHostProcess(70001, ps), false, "ターミナルの Codex は常駐ではない");
  assert.equal(await isHostProcess(70002, ps), false, "codex exec は常駐ではない");
  assert.equal(await isHostProcess(87592, ps), false);
  assert.equal(await isHostProcess(99999, ps), false);
});

test("寄せたあと放置で終わった本物は、片割れに残った Claude の pid が生きていれば running に戻して pid を移す", async (t) => {
  const store = fixture(t);
  const base = { repoKey: "r", client: "claude", traceId: "a".repeat(32), startedAt: ts };
  store.insertNamedSession({ id: "e34c542e-c349-477a-b5f3-3d6bab20a63a", ...base });
  store.endSession("e34c542e-c349-477a-b5f3-3d6bab20a63a", ts, "idle");
  store.insertNamedSession({ id: "01M43PZEB8KN6CVF8T1TN8JDAY", ...base, pid: 54834, pidStartedAt: "Mon Oct  5 00:02:04 2026" });
  store.endSession("01M43PZEB8KN6CVF8T1TN8JDAY", ts, "explicit");
  const now = new Date("2026-10-06T11:00:00.000Z");
  // 片割れの pid が死んでいれば戻さない
  await reconcileLiveness(store, { now: () => now, isAlive: async () => false, isHost: async () => false });
  assert.equal(store.getSession("e34c542e-c349-477a-b5f3-3d6bab20a63a")?.status, "ended");
  await reconcileLiveness(store, { now: () => now, isAlive: async (pid) => pid === 54834, isHost: async () => false });
  const real = store.getSession("e34c542e-c349-477a-b5f3-3d6bab20a63a")!;
  assert.equal(real.status, "running");
  assert.equal(real.pid, 54834);
  assert.equal(real.pidStartedAt, "Mon Oct  5 00:02:04 2026");
});
