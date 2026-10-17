import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { JsonValue } from "../../core/src/ledger/facts.ts";
import type { RunnerEvent, RunnerRequest, RunnerResponse } from "../src/runner-client.ts";
import { createRunnerPty, type RunnerPtyClient, type RunnerTerminalInfo } from "../src/terminal/runner-pty.ts";

const input = { file: "claude", args: ["--resume", "session"], cwd: "/work",
  env: { PATH: "/bin", OMIT: undefined }, cols: 80, rows: 24,
  meta: { provider: "claude", target: { type: "local" } } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function createInfo(terminalId = "term"): RunnerTerminalInfo {
  return { terminalId, pid: 123, meta: input.meta, startedAt: "2026-10-17T00:00:00.000Z", scrollback: "startup" };
}

class FakeRunnerClient implements RunnerPtyClient {
  available = true;
  connectionGeneration = 1;
  requests: RunnerRequest[] = [];
  infos: RunnerTerminalInfo[] = [];
  onEvent: (event: RunnerEvent) => void = () => {};
  respond?: (request: RunnerRequest) => Promise<JsonValue>;
  error?: string;
  async request(request: RunnerRequest): Promise<RunnerResponse> {
    this.requests.push(structuredClone(request));
    if (!this.available || this.error) return { type: "res", cmd_id: request.cmd_id, ok: false, error: this.error ?? "Runner unavailable" };
    let result: JsonValue;
    if (this.respond) result = await this.respond(request);
    else if (request.command === "terminal.spawn") {
      this.infos.push(createInfo());
      this.onEvent({ type: "evt", terminal: { terminalId: "term", output: "startup" } });
      result = { terminalId: "term", pid: 123 };
    } else if (request.command === "terminal.list") result = JSON.parse(JSON.stringify(this.infos));
    else result = {};
    return { type: "res", cmd_id: request.cmd_id, ok: true, result };
  }
}
function createFixture(t: TestContext) {
  const client = new FakeRunnerClient();
  const errors: Error[] = [];
  const adapter = createRunnerPty(client, { onError: error => errors.push(error) });
  client.onEvent = adapter.handleEvent;
  t.after(() => adapter.close());
  return { client, adapter, errors };
}

test("spawn returns a PTY with runner identity and recovers output before the response", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  assert.equal(terminal.terminalId, "term");
  assert.equal(terminal.pid, 123);
  assert.deepEqual(terminal.meta, input.meta);
  assert.equal(terminal.startedAt, createInfo().startedAt);
  assert.deepEqual(client.requests.map(request => request.command), ["terminal.spawn", "terminal.list"]);
  assert.deepEqual(client.requests[0].payload, { ...input, env: { PATH: "/bin" } });
  const output: string[] = [];
  terminal.onData(data => output.push(data));
  assert.deepEqual(output, ["startup"]);
});

test("write, Buffer write, resize and kill use distinct command ids and the same terminalId", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  terminal.write("hello\r");
  terminal.write(Buffer.from("日本語"));
  terminal.resize(120, 40);
  terminal.kill();
  await tick();
  assert.deepEqual(client.requests.slice(2).map(({ command, payload }) => ({ command, payload })), [
    { command: "terminal.write", payload: { terminalId: "term", data: "hello\r" } },
    { command: "terminal.write", payload: { terminalId: "term", data: "日本語" } },
    { command: "terminal.resize", payload: { terminalId: "term", cols: 120, rows: 40 } },
    { command: "terminal.kill", payload: { terminalId: "term" } },
  ]);
  assert.equal(new Set(client.requests.map(request => request.cmd_id)).size, client.requests.length);
  assert.throws(() => terminal.write("late"), /Unknown terminal/);
});

test("events are routed by terminalId and subscriptions dispose independently", async t => {
  const { client, adapter } = createFixture(t);
  client.infos = [createInfo(), { ...createInfo("other"), scrollback: "" }];
  const [terminal, other] = await adapter.list();
  const output: string[] = [], otherOutput: string[] = [], exits: unknown[] = [];
  const dataSubscription = terminal.onData(data => output.push(data));
  const exitSubscription = terminal.onExit(exit => exits.push(exit));
  other.onData(data => otherOutput.push(data));
  for (const event of [
    { type: "evt", seq: 5 }, { type: "evt", delta: { runId: "run", text: "ignored" } },
    { type: "evt", terminal: { terminalId: "unknown", output: "ignored" } },
    { type: "evt", terminal: { terminalId: "other", output: "other" } },
    { type: "evt", terminal: { terminalId: "term", output: "live" } },
  ] satisfies RunnerEvent[]) adapter.handleEvent(event);
  dataSubscription.dispose(); exitSubscription.dispose();
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: "disposed" } });
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", exit: { exitCode: 7, signal: 15 } } });
  assert.deepEqual(output, ["startup", "live"]);
  assert.deepEqual(otherOutput, ["other"]);
  assert.deepEqual(exits, []);
  const lateExits: unknown[] = [];
  terminal.onExit(exit => lateExits.push(exit));
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", exit: { exitCode: 1 } } });
  assert.deepEqual(lateExits, [{ exitCode: 7, signal: 15 }]);
  assert.throws(() => terminal.write("late"), /exited/);
});

test("list reattaches an existing terminal after api restart without spawning", async t => {
  const { client, adapter } = createFixture(t);
  client.infos = [{ ...createInfo(), exited: { exitCode: 2 } }];
  const [terminal] = await adapter.list();
  const output: string[] = [], exits: unknown[] = [];
  terminal.onData(data => output.push(data));
  terminal.onExit(exit => exits.push(exit));
  assert.deepEqual(output, ["startup"]);
  assert.deepEqual(exits, [{ exitCode: 2 }]);
  assert.equal((await adapter.list())[0], terminal);
  assert.deepEqual(output, ["startup"]);
  assert.ok(client.requests.every(request => request.command === "terminal.list"));
});

test("a changed generation restores scrollback on the same PTY and receives live output", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  const output: string[] = [], exits: unknown[] = [];
  terminal.onData(data => output.push(data)); terminal.onExit(exit => exits.push(exit));
  client.available = false;
  await adapter.refresh();
  assert.deepEqual(exits, []);
  client.infos[0].scrollback = "startup offline";
  client.available = true;
  client.connectionGeneration++;
  await Promise.all([adapter.refresh(), adapter.refresh()]);
  assert.deepEqual(output, ["startup", "\x1bcstartup offline"]);
  assert.equal(client.requests.filter(request => request.command === "terminal.list").length, 2);
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: " live" } });
  assert.equal(output.at(-1), " live");
  terminal.write("after reconnect");
  assert.deepEqual(client.requests.at(-1)?.payload, { terminalId: "term", data: "after reconnect" });
  client.infos[0] = { ...client.infos[0], scrollback: "final", exited: { exitCode: 9 } };
  client.connectionGeneration++;
  await adapter.refresh();
  await adapter.refresh();
  assert.deepEqual(exits, [{ exitCode: 9 }]);
});

test("polling notices a reconnect even without events or operations", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  const output: string[] = [];
  terminal.onData(data => output.push(data));
  client.connectionGeneration++;
  client.infos[0].scrollback = "offline";
  t.mock.timers.tick(500);
  await tick();
  assert.deepEqual(output, ["startup", "\x1bcoffline"]);
});

test("events after a list response in the same receive batch follow the restored snapshot", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  const output: string[] = [], exits: unknown[] = [];
  terminal.onData(data => output.push(data));
  terminal.onExit(exit => exits.push(exit));
  let resolve!: (response: RunnerResponse) => void;
  client.request = request => {
    client.requests.push(request);
    return new Promise(done => { resolve = done; });
  };
  client.connectionGeneration++;
  const pending = adapter.refresh();
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: "offline" } });
  await tick();
  resolve({ type: "res", cmd_id: client.requests.at(-1)!.cmd_id, ok: true,
    result: JSON.parse(JSON.stringify([{ ...createInfo(), scrollback: "startupoffline" }])) });
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: "live" } });
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", exit: { exitCode: 0 } } });
  await pending;
  assert.deepEqual(output, ["startup", "\x1bcstartupoffline", "live"]);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
  assert.equal(terminal.scrollback, "startupofflinelive");
});

test("scrollback remains bounded and preserves UTF-8 at the truncation boundary", async t => {
  const { client, adapter } = createFixture(t);
  client.infos = [{ ...createInfo(), scrollback: "" }];
  const [terminal] = await adapter.list();
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: "あ".repeat(100_000) + "tail" } });
  assert.ok(Buffer.byteLength(terminal.scrollback) <= 256 * 1024);
  assert.equal(terminal.scrollback.includes("\ufffd"), false);
  assert.ok(terminal.scrollback.endsWith("tail"));
});

test("failed reattach retries and stale snapshots do not replace newer connection state", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  client.connectionGeneration++;
  client.error = "list failed";
  await assert.rejects(adapter.refresh(), /list failed/);
  client.error = undefined;
  let resolve!: (result: JsonValue) => void;
  client.respond = () => new Promise(done => { resolve = done; });
  const pending = adapter.refresh();
  client.connectionGeneration++;
  resolve([]);
  await assert.rejects(pending, /connection changed/);
  client.respond = undefined;
  await adapter.refresh();
  assert.equal((await adapter.list())[0], terminal);
});

test("runner restart missing terminals are detached without inventing an exit", async t => {
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  const exits: unknown[] = [];
  terminal.onExit(exit => exits.push(exit));
  client.infos = [];
  client.connectionGeneration++;
  await adapter.refresh();
  assert.deepEqual(exits, []);
  assert.throws(() => terminal.write("missing"), /Unknown terminal/);
  assert.deepEqual(await adapter.list(), []);
});

test("command failures are reported without unhandled rejections or automatic retries", async t => {
  const { client, adapter, errors } = createFixture(t);
  client.error = "unsupported";
  await assert.rejects(adapter.spawn(input), /unsupported/);
  await assert.rejects(adapter.list(), /unsupported/);
  client.error = undefined;
  const terminal = await adapter.spawn(input);
  client.error = "write failed";
  terminal.write("input"); terminal.resize(100, 30); terminal.kill();
  await tick();
  assert.deepEqual(errors.map(error => error.message), ["write failed", "write failed", "write failed"]);
  assert.equal(client.requests.filter(request => request.command === "terminal.write").length, 1);
});

test("close releases callbacks and polling without killing runner terminals", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { client, adapter } = createFixture(t);
  const terminal = await adapter.spawn(input);
  const output: string[] = [];
  terminal.onData(data => output.push(data));
  adapter.close(); adapter.close();
  client.connectionGeneration++;
  t.mock.timers.tick(1000);
  await tick();
  adapter.handleEvent({ type: "evt", terminal: { terminalId: "term", output: "ignored" } });
  assert.deepEqual(output, ["startup"]);
  assert.deepEqual(client.requests.map(request => request.command), ["terminal.spawn", "terminal.list"]);
  assert.throws(() => terminal.write("closed"), /closed/);
  await assert.rejects(adapter.list(), /closed/);
});

test("a list response arriving after close cannot recreate subscriptions", async t => {
  const { client, adapter } = createFixture(t);
  let resolve!: (result: JsonValue) => void;
  client.respond = () => new Promise(done => { resolve = done; });
  const pending = adapter.list();
  adapter.close();
  resolve(JSON.parse(JSON.stringify([createInfo()])));
  await assert.rejects(pending, /closed/);
  await adapter.refresh();
  assert.equal(client.requests.length, 1);
});
