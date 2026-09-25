import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { isProcessAlive, processStartedAt, reconcileLiveness, startLivenessMonitor } from "../src/liveness.ts";

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
