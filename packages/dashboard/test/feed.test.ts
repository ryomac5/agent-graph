import assert from "node:assert/strict";
import test from "node:test";
import { openFeed, RETRY_MS } from "../public/ui/feed.js";

// 偽のタイマー。tick で進め、期限が来たものだけを順に走らせる
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => { seq += 1; timers.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    async tick(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        // fetch の解決を進める
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

// 偽の EventSource。open と error と project を手で起こす
class FakeSource {
  static instances: FakeSource[] = [];
  listeners = new Map<string, ((ev: { data?: string }) => void)[]>();
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeSource.instances.push(this); }
  addEventListener(name: string, fn: (ev: { data?: string }) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name)!.push(fn);
  }
  emit(name: string, ev: { data?: string } = {}) { for (const fn of this.listeners.get(name) ?? []) fn(ev); }
  close() { this.closed = true; }
}

function setup(fetchImpl: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>) {
  FakeSource.instances = [];
  const timers = fakeTimers();
  let fetches = 0;
  const data: unknown[] = [];
  const states: string[] = [];
  const errors: string[] = [];
  const feed = openFeed("r", {
    onData: (d) => data.push(d), onState: (s) => states.push(s), onError: (m) => errors.push(m),
  }, { fetch: async () => { fetches += 1; return fetchImpl(); }, EventSource: FakeSource, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  return { feed, timers, data, states, errors, fetches: () => fetches };
}

// 初回の取得はタイマーを通らないので、本物のイベントループで解決を待つ
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const failing = async () => ({ ok: false, status: 501, json: async () => ({ error: "not implemented" }) });
const succeeding = async () => ({ ok: true, status: 200, json: async () => ({ project: { key: "r" } }) });

test("SSE の失敗が続いても REST の取得は 2 秒に 1 回のまま増えない", async () => {
  const { feed, timers, fetches, states } = setup(failing);
  // 初回の fetch。接続は error を繰り返す
  await timers.tick(0);
  const before = fetches();
  for (let round = 0; round < 10; round++) {
    const source = FakeSource.instances.at(-1)!;
    source.emit("error");
    await timers.tick(RETRY_MS);
  }
  const elapsedRounds = 10;
  const made = fetches() - before;
  assert.ok(made <= elapsedRounds + 1, `20 秒で ${made} 回の fetch になった`);
  assert.ok(made >= elapsedRounds - 1, `fetch が ${made} 回しか無い`);
  assert.ok(states.includes("offline"));
  assert.ok(timers.pending <= 2, `タイマーが ${timers.pending} 本ある`);
  feed.close();
  assert.equal(timers.pending, 0);
});

test("接続が戻ればポーリングは止まり、飛んでいる fetch の結果は捨てる", async () => {
  let release: (() => void) | undefined;
  const slow = () => new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => ({ stale: true }) });
  });
  const { feed, timers, data, fetches, states } = setup(slow);
  await timers.tick(0);
  assert.equal(fetches(), 1);
  const source = FakeSource.instances.at(-1)!;
  source.emit("error");
  await timers.tick(RETRY_MS);
  // 飛んでいる間は 2 つ目を走らせない
  assert.equal(fetches(), 1);
  const next = FakeSource.instances.at(-1)!;
  next.emit("open");
  next.emit("project", { data: JSON.stringify({ fresh: true }) });
  release!();
  await timers.tick(0);
  assert.deepEqual(data, [{ fresh: true }]);
  assert.equal(states.at(-1), "live");
  await timers.tick(RETRY_MS * 5);
  assert.equal(fetches(), 1);
  assert.ok(feed.live);
  feed.close();
});

test("取得の失敗は onError に理由を渡し、成功で REST の全体を受ける", async () => {
  const failed = setup(failing);
  await flush();
  assert.deepEqual(failed.errors, ["HTTP 501"]);
  assert.equal(failed.data.length, 0);
  failed.feed.close();
  const ok = setup(succeeding);
  await flush();
  assert.deepEqual(ok.data, [{ project: { key: "r" } }]);
  assert.deepEqual(ok.errors, []);
  ok.feed.close();
});
