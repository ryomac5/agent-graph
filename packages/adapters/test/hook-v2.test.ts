import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createHookEvent, enqueueHook, flushHookOutbox, resolveHookGeneration, resolveHookOutbox, sendHook } from "../src/hook-v2/index.ts";

async function createOutbox(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-graph-hook-v2-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "outbox");
}

async function startReceiver(t: TestContext, accept = true, delay = 0) {
  const received: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const event = JSON.parse(String(options.body));
    received.push(event);
    assert.equal((options.headers as Record<string, string>).authorization, "Bearer current-token");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
    });
    return new Response(JSON.stringify({ accepted: accept, event_id: event.event_id,
      generation: event.generation, session_id: event.session_id }));
  });
  return { received, destination: { url: "http://127.0.0.1:12345/hook-v2", token: "current-token" } };
}

function createEvent(id: string) {
  return createHookEvent({ session_id: "session", generation: 1, event_id: id, hook_event_name: "Stop" }, {});
}

test("受け口が無い間は待ちを残し、次の hook で過去の出来事も送って消す", async (t) => {
  const outbox = await createOutbox(t);
  const event = createEvent("offline");
  const unavailable = { url: "http://127.0.0.1:12345/hook-v2", token: "current-token" };
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("ECONNREFUSED"); });
  assert.equal(await sendHook(event, { outbox, destination: unavailable }), 0);
  const files = await readdir(outbox);
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(outbox, files[0]), "utf8")), event);
  const receiver = await startReceiver(t);
  assert.equal(await sendHook(createEvent("online"), { outbox, destination: receiver.destination }), 2);
  assert.deepEqual(receiver.received.map((item) => item.event_id).sort(), ["offline", "online"]);
  assert.deepEqual(await readdir(outbox), []);
});

test("完成した JSON を原子的に公開し、途中ファイルを再送しない", async (t) => {
  const outbox = await createOutbox(t);
  const events = Array.from({ length: 20 }, (_, index) => ({ ...createEvent(`atomic-${index}`),
    input: { body: "x".repeat(100_000) } }));
  let writing = true;
  const writes = Promise.all(events.map((event) => enqueueHook(event, outbox))).finally(() => { writing = false; });
  while (writing) {
    let names: string[];
    try { names = await readdir(outbox); } catch { continue; }
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      assert.equal(JSON.parse(await readFile(join(outbox, name), "utf8")).input.body.length, 100_000);
    }
  }
  const paths = await writes;
  assert.equal((await readdir(outbox)).length, events.length);
  assert.equal((await stat(paths[0])).mode & 0o777, 0o600);
  await writeFile(join(outbox, ".interrupted.tmp"), "{");
  const receiver = await startReceiver(t);
  assert.equal(await flushHookOutbox({ outbox, destination: receiver.destination, budgetMs: 5000 }), events.length);
  assert.deepEqual(await readdir(outbox), [".interrupted.tmp"]);
});

test("受理の拒否とタイムアウトでは消さず、送信待ち時間を制限する", async (t) => {
  const outbox = await createOutbox(t);
  await enqueueHook(createEvent("retry"), outbox);
  const rejected = await startReceiver(t, false);
  assert.equal(await flushHookOutbox({ outbox, destination: rejected.destination }), 0);
  const slow = await startReceiver(t, true, 200);
  const started = performance.now();
  assert.equal(await flushHookOutbox({ outbox, destination: slow.destination, timeoutMs: 30, budgetMs: 60 }), 0);
  assert.ok(performance.now() - started < 500);
  assert.equal((await readdir(outbox)).length, 1);
});

test("世代と managed の情報を固定し、保存先は状態ディレクトリに置く", () => {
  const input = { session_id: "session", hook_event_name: "SessionEnd" };
  const env = { AGENT_GRAPH_GENERATION: "3", AGENT_GRAPH_MANAGED: "1", AGENT_GRAPH_RUN_ID: "run" };
  const event = createHookEvent(input, env);
  assert.equal(event.generation, 3);
  assert.equal(event.managed, true);
  assert.equal(event.run_id, "run");
  assert.notEqual(createHookEvent(input, env).event_id, event.event_id);
  assert.throws(() => createHookEvent(input, {}));
  assert.equal(resolveHookOutbox({}, "/home/test"), "/home/test/.local/state/agent-graph/outbox");
  assert.equal(resolveHookOutbox({ XDG_STATE_HOME: "/state" }), "/state/agent-graph/outbox");
});

test("通常の hook は世代を永続化し、再開の SessionStart で新しい世代にする", async (t) => {
  const outbox = await createOutbox(t);
  const input = { session_id: "native", hook_event_name: "SessionStart", source: "startup" };
  const first = await resolveHookGeneration(input, outbox, {});
  assert.equal(await resolveHookGeneration({ ...input, hook_event_name: "Stop" }, outbox, {}), first);
  for (const source of ["compact", "clear", undefined]) {
    assert.equal(await resolveHookGeneration({ ...input, source: source ?? null }, outbox, {}), first);
  }
  const second = await resolveHookGeneration({ ...input, source: "resume" }, outbox, {});
  assert.ok(second > first);
  assert.equal(await resolveHookGeneration({ ...input, hook_event_name: "SessionEnd" }, outbox, {}), second);
  assert.ok(await resolveHookGeneration(input, outbox, {}) > second);
});

test("入力の拒否でも元の出来事を残し、後続を送ってから次の起動で再送する", async (t) => {
  for (const status of [400, 409, 413]) {
    const outbox = await createOutbox(t);
    const paths = await Promise.all(["first", "second"].map((id) => enqueueHook(createEvent(id), outbox)));
    paths.sort();
    const rejectedBody = await readFile(paths[0], "utf8");
    const acceptedEvent = JSON.parse(await readFile(paths[1], "utf8"));
    const received: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
      const event = JSON.parse(String(options.body));
      received.push(event.event_id);
      if (event.event_id !== acceptedEvent.event_id) return new Response("refused", { status });
      return new Response(JSON.stringify({ accepted: true, event_id: event.event_id,
        generation: event.generation, session_id: event.session_id }));
    });
    const destination = { url: "http://127.0.0.1:12345/hook-v2", token: "token" };
    assert.equal(await flushHookOutbox({ outbox, destination }), 1);
    assert.equal(received.length, 2);
    assert.equal(received[1], acceptedEvent.event_id);
    assert.equal((await readdir(outbox)).length, 1);
    assert.equal(await readFile(paths[0], "utf8"), rejectedBody);
    const receiver = await startReceiver(t);
    assert.equal(await flushHookOutbox({ outbox, destination: receiver.destination }), 1);
    assert.deepEqual(await readdir(outbox), []);
    assert.equal(receiver.received[0].event_id, JSON.parse(rejectedBody).event_id);
  }
});

test("一時的な拒否は隔離せず、受け口の復帰後に再送する", async (t) => {
  for (const status of [403, 429, 503]) {
    const outbox = await createOutbox(t);
    const event = createEvent(`retry-${status}`);
    const path = await enqueueHook(event, outbox);
    t.mock.method(globalThis, "fetch", async () => new Response("retry", { status }));
    const destination = { url: "http://127.0.0.1:12345/hook-v2", token: "token" };
    assert.equal(await flushHookOutbox({ outbox, destination }), 0);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), event);
    assert.equal((await readdir(outbox)).length, 1);
    const receiver = await startReceiver(t);
    assert.equal(await flushHookOutbox({ outbox, destination: receiver.destination }), 1);
    assert.deepEqual(await readdir(outbox), []);
  }
});

test("大きな入力も本文を切り詰めずに保存し、同じ内容を送る", async (t) => {
  const outbox = await createOutbox(t);
  const event = { ...createEvent("large"), hook_event_name: "PostToolUse",
    input: { tool_response: '結果😀"\\'.repeat(150_000), agent_id: "child", entrypoint: "sdk-cli", source: "compact" } };
  const original = structuredClone(event);
  const path = await enqueueHook(event, outbox);
  const storedBody = await readFile(path, "utf8");
  const stored = JSON.parse(storedBody);
  assert.ok(Buffer.byteLength(storedBody) > 1_048_576);
  assert.deepEqual(stored, event);
  assert.deepEqual(event, original);
  assert.equal(await enqueueHook(event, outbox), path);
  const received: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = String(options.body);
    received.push(body);
    assert.deepEqual(JSON.parse(body), event);
    return new Response(JSON.stringify({ accepted: true, event_id: event.event_id,
      generation: event.generation, session_id: event.session_id }));
  });
  assert.equal(await flushHookOutbox({ outbox, destination: { url: "http://127.0.0.1:12345/hook-v2", token: "token" } }), 1);
  assert.deepEqual(received, [storedBody]);
  assert.deepEqual(await readdir(outbox), []);
});

test("同じ出来事の並行保存は増えず、内容の違う再保存で上書きしない", async (t) => {
  const outbox = await createOutbox(t);
  const event = createEvent("same");
  const paths = await Promise.all(Array.from({ length: 5 }, () => enqueueHook(event, outbox)));
  assert.equal(new Set(paths).size, 1);
  assert.equal((await readdir(outbox)).length, 1);
  await assert.rejects(enqueueHook({ ...event, input: { changed: true } }, outbox));
  assert.deepEqual(JSON.parse(await readFile(paths[0], "utf8")), event);
});

test("出来事と一致しない受理応答では送信待ちを消さない", async (t) => {
  const outbox = await createOutbox(t);
  await enqueueHook(createEvent("ack"), outbox);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ accepted: true,
    event_id: "different-event", generation: 1, session_id: "session" })));
  assert.equal(await flushHookOutbox({ outbox, destination: { url: "http://127.0.0.1:12345/hook-v2", token: "token" } }), 0);
  assert.equal((await readdir(outbox)).length, 1);
});

test("受理後に応答を失っても、同じ ID と本文で再送してから消す", async (t) => {
  const outbox = await createOutbox(t);
  const event = createEvent("lost-ack");
  const accepted = new Map<string, unknown>();
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const received = JSON.parse(String(options.body));
    assert.deepEqual(received, event);
    accepted.set(received.event_id, received);
    if (attempts++ === 0) throw new TypeError("Response lost after acceptance");
    return new Response(JSON.stringify({ accepted: true, event_id: received.event_id,
      generation: received.generation, session_id: received.session_id }));
  });
  const options = { outbox, destination: { url: "http://127.0.0.1:12345/hook-v2", token: "token" } };
  assert.equal(await sendHook(event, options), 0);
  assert.equal((await readdir(outbox)).length, 1);
  assert.equal(await flushHookOutbox(options), 1);
  assert.equal(attempts, 2);
  assert.equal(accepted.size, 1);
  assert.deepEqual(await readdir(outbox), []);
});

test("送信先ファイルを読み直し、起動ごとのトークン変更に追従する", async (t) => {
  const outbox = await createOutbox(t);
  await enqueueHook(createEvent("token"), outbox);
  const destinationFile = join(outbox, ".endpoint");
  await writeFile(destinationFile, JSON.stringify({ url: "http://127.0.0.1:12345/hook-v2", token: "old-token" }));
  const receiver = await startReceiver(t);
  assert.equal(await flushHookOutbox({ outbox, destinationFile }), 0);
  await writeFile(destinationFile, JSON.stringify(receiver.destination));
  assert.equal(await flushHookOutbox({ outbox, destinationFile }), 1);
  assert.deepEqual(await readdir(outbox), [".endpoint"]);
});
