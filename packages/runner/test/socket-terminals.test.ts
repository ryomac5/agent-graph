import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { openLedger } from "../../core/src/ledger/index.ts";
import { RunnerRuntime } from "../src/runtime.ts";
import { RunnerProtocol, PROTOCOL_VERSION, MAX_FRAME_BYTES, MAX_TERMINAL_OUTPUT_BYTES,
  type ClientRole, type SocketRequest, type SocketResponse, type RunnerEvent } from "../src/socket.ts";
import type { TerminalExit, TerminalProcess } from "../src/terminals/index.ts";
import { RunnerClient, RUNNER_PROTOCOL_VERSION, type RunnerEvent as ApiEvent } from "../../api/src/runner-client.ts";

class FakeSocket extends Duplex {
  messages: (SocketResponse | RunnerEvent | { type: "hello"; version: number; role: string })[] = [];
  blocked = false;
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.messages.push(JSON.parse(chunk.toString()));
    if (!this.blocked) callback();
  }
  send(value: unknown): void { this.emit("data", JSON.stringify(value) + "\n"); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const spawnRequest = { file: "claude", args: ["--resume", "session"], cwd: "/work", env: { PATH: "/bin" },
  cols: 80, rows: 24, meta: { provider: "claude", target: { type: "local" } } };

function createFixture(t: TestContext) {
  const ledger = openLedger(":memory:");
  const processes: { writes: (string | Buffer)[]; sizes: number[][]; kills: number;
    data?: (data: string) => void; exit?: (exit: TerminalExit) => void }[] = [];
  const calls: unknown[] = [];
  let protocol: RunnerProtocol;
  const runtime = new RunnerRuntime(ledger, [], event => protocol.publish(event), "shared", {
    openTerminal(...args): TerminalProcess {
      calls.push(args);
      const state: typeof processes[number] = { writes: [], sizes: [], kills: 0 };
      processes.push(state);
      return { pid: 100 + processes.length,
        write(data) { state.writes.push(data); }, resize(cols, rows) { state.sizes.push([cols, rows]); },
        kill() { state.kills++; state.exit?.({ exitCode: 0, signal: 15 }); },
        onData(listener) { state.data = listener; return { dispose() { state.data = undefined; } }; },
        onExit(listener) { state.exit = listener; return { dispose() { state.exit = undefined; } }; },
      };
    },
  });
  protocol = new RunnerProtocol((request, role) => runtime.command(request, role));
  let nextId = 0;
  function connect(role: ClientRole = "api") {
    const socket = new FakeSocket();
    protocol.attach(socket as unknown as Socket);
    socket.send({ type: "hello", version: PROTOCOL_VERSION, role });
    async function request(command: string, payload?: SocketRequest["payload"], cmd_id = String(++nextId)) {
      const start = socket.messages.length;
      socket.send({ type: "req", command, payload, cmd_id });
      await tick();
      const response = socket.messages.slice(start).find((message): message is SocketResponse => message.type === "res" && message.cmd_id === cmd_id);
      assert.ok(response);
      return response;
    }
    return { socket, request };
  }
  t.after(async () => { protocol.disconnect(); await runtime.close(); ledger.close(); });
  return { runtime, protocol, processes, calls, connect };
}
function readResult(response: SocketResponse): any {
  assert.equal(response.ok, true);
  return response.result;
}
function readEvents(socket: FakeSocket) { return socket.messages.filter(message => message.type === "evt"); }

test("api can spawn, list, write, resize and kill with stable identity after reconnect", async t => {
  const { connect, processes, calls } = createFixture(t);
  const first = connect();
  const spawned = readResult(await first.request("terminal.spawn", spawnRequest, "spawn"));
  assert.equal(spawned.pid, 101);
  assert.equal(calls.length, 1);
  first.socket.destroy();
  processes[0].data?.("offline");
  await tick();
  const second = connect();
  assert.deepEqual(readResult(await second.request("terminal.spawn", spawnRequest, "spawn")), spawned);
  assert.equal(calls.length, 1);
  const [info] = readResult(await second.request("terminal.list", undefined, "list"));
  assert.deepEqual(info, { ...spawned, meta: spawnRequest.meta, startedAt: info.startedAt, scrollback: "offline" });
  assert.ok(Number.isFinite(Date.parse(info.startedAt)));
  readResult(await second.request("terminal.write", { terminalId: spawned.terminalId, data: "hello\r" }));
  readResult(await second.request("terminal.resize", { terminalId: spawned.terminalId, cols: 120, rows: 40 }));
  assert.deepEqual(processes[0].writes, ["hello\r"]);
  assert.deepEqual(processes[0].sizes, [[120, 40]]);
  processes[0].data?.(" later");
  assert.equal(readResult(await second.request("terminal.list", undefined, "list"))[0].scrollback, "offline later");
  processes[0].exit?.({ exitCode: 7 });
  assert.deepEqual(readResult(await second.request("terminal.list"))[0].exited, { exitCode: 7 });
  assert.deepEqual(readEvents(second.socket).at(-1), { type: "evt", terminal: { terminalId: spawned.terminalId, exit: { exitCode: 7 } } });
  readResult(await second.request("terminal.kill", { terminalId: spawned.terminalId }));
  assert.deepEqual(readResult(await second.request("terminal.list")), []);
  const live = readResult(await second.request("terminal.spawn", spawnRequest));
  readResult(await second.request("terminal.kill", { terminalId: live.terminalId }));
  assert.equal(processes[1].kills, 1);
});

test("terminal permissions precede cached responses; legacy peers receive only existing events", async t => {
  const { connect, protocol, calls } = createFixture(t);
  const api = connect(), oldApi = connect();
  const spawned = readResult(await api.request("terminal.spawn", spawnRequest, "shared"));
  for (const role of ["cli", "mcp"] as const) {
    const peer = connect(role);
    for (const command of ["spawn", "list", "write", "resize", "kill"]) {
      const response = await peer.request(`terminal.${command}`, { ...spawnRequest, terminalId: spawned.terminalId, data: "bad" }, "shared");
      assert.equal(response.ok, false);
    }
    protocol.publish({ type: "evt", terminal: { terminalId: spawned.terminalId, output: "private" } });
    await tick();
    assert.deepEqual(readEvents(peer.socket), []);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(readEvents(oldApi.socket), []);
  assert.equal(oldApi.socket.destroyed, false);
  const status = readResult(await oldApi.request("status"));
  assert.equal(status.capabilities.terminals, true);
  protocol.publish({ type: "evt", seq: 1 });
  assert.deepEqual(readEvents(oldApi.socket), [{ type: "evt", seq: 1 }]);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(RUNNER_PROTOCOL_VERSION, 1);
});

test("keystrokes, resizes and list snapshots do not accumulate in response cache", async t => {
  const { connect, protocol, processes } = createFixture(t);
  const peer = connect();
  const { terminalId } = readResult(await peer.request("terminal.spawn", spawnRequest));
  for (let i = 0; i < 100; i++) {
    peer.socket.send({ type: "req", command: "terminal.write", cmd_id: `write-${i}`, payload: { terminalId, data: "x" } });
    peer.socket.send({ type: "req", command: "terminal.resize", cmd_id: `resize-${i}`, payload: { terminalId, cols: 80, rows: 24 } });
  }
  await tick();
  await peer.request("terminal.list");
  const responses = (protocol as unknown as { responses: Map<string, unknown> }).responses;
  assert.equal(responses.size, 1);
  assert.equal(processes[0].writes.length, 100);
  assert.equal(processes[0].sizes.length, 100);
  assert.equal((await peer.request("terminal.write", { terminalId: "missing", data: "x" })).ok, false);
  assert.equal(responses.size, 1);
});

test("output batches before exit and bounds pending output with scrollback recovery", async t => {
  const { connect, processes } = createFixture(t);
  const peer = connect();
  const { terminalId } = readResult(await peer.request("terminal.spawn", spawnRequest));
  processes[0].data?.("one"); processes[0].data?.("two");
  assert.deepEqual(readEvents(peer.socket), []);
  processes[0].exit?.({ exitCode: 0 });
  assert.deepEqual(readEvents(peer.socket), [
    { type: "evt", terminal: { terminalId, output: "onetwo" } },
    { type: "evt", terminal: { terminalId, exit: { exitCode: 0 } } },
  ]);
  await peer.request("terminal.spawn", spawnRequest);
  processes[1].data?.("x".repeat(MAX_TERMINAL_OUTPUT_BYTES));
  processes[1].data?.("tail");
  assert.equal(peer.socket.destroyed, true);
  await tick();
  const reconnected = connect();
  const infos = readResult(await reconnected.request("terminal.list"));
  assert.equal(infos[1].scrollback, "x".repeat(MAX_TERMINAL_OUTPUT_BYTES) + "tail");
  assert.deepEqual(readEvents(reconnected.socket), []);
});

test("slow sockets hit existing writableLength limit without losing terminal ownership", async t => {
  const { connect, processes } = createFixture(t);
  const peer = connect();
  const { terminalId } = readResult(await peer.request("terminal.spawn", spawnRequest));
  peer.socket.blocked = true;
  for (let i = 0; i < MAX_FRAME_BYTES / MAX_TERMINAL_OUTPUT_BYTES + 3; i++) {
    processes[0].data?.("x".repeat(MAX_TERMINAL_OUTPUT_BYTES));
    await tick();
  }
  assert.equal(peer.socket.destroyed, true);
  assert.equal(processes[0].kills, 0);
  const reconnected = connect();
  const infos = readResult(await reconnected.request("terminal.list"));
  assert.equal(infos[0].terminalId, terminalId);
  assert.ok(infos[0].scrollback.endsWith("x"));
});

test("api client forwards terminal events and remains compatible with an old runner", async t => {
  const net = await import("node:net");
  const socket = new FakeSocket();
  t.mock.method(net.default, "createConnection", () => socket as unknown as Socket);
  // named import も mock に同期し、listen を使わず client の受信経路を検証する。
  const { syncBuiltinESMExports } = await import("node:module");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const events: ApiEvent[] = [];
  const client = new RunnerClient<ApiEvent>("unused", event => events.push(event));
  t.after(() => client.close());
  socket.emit("connect");
  socket.send({ type: "hello", version: 1, role: "runner" });
  assert.equal(client.available, true);
  socket.send({ type: "evt", seq: 1 });
  socket.send({ type: "evt", delta: { runId: "run", text: "old" } });
  const output = { type: "evt" as const, terminal: { terminalId: "term", output: "hello" } };
  const exit = { type: "evt" as const, terminal: { terminalId: "term", exit: { exitCode: 0, signal: 15 } } };
  socket.send(output); socket.send(exit);
  assert.deepEqual(events, [{ type: "evt", seq: 1 }, { type: "evt", delta: { runId: "run", text: "old" } }, output, exit]);
  assert.equal(socket.destroyed, false);
  const pending = client.request({ type: "req", cmd_id: "unsupported", command: "terminal.list" });
  socket.send({ type: "res", cmd_id: "unsupported", ok: false, error: "Unknown command: terminal.list" });
  assert.equal((await pending).ok, false);
  assert.equal(client.available, true);
  const snapshot = [{ terminalId: "term", scrollback: "x".repeat(2 * MAX_FRAME_BYTES) }];
  const list = client.request({ type: "req", cmd_id: "snapshot", command: "terminal.list" });
  const frame = JSON.stringify({ type: "res", cmd_id: "snapshot", ok: true, result: snapshot }) + "\n";
  socket.emit("data", frame.slice(0, MAX_FRAME_BYTES + 1));
  assert.equal(socket.destroyed, false);
  socket.emit("data", frame.slice(MAX_FRAME_BYTES + 1));
  assert.deepEqual(readResult(await list), snapshot);
  assert.equal(client.available, true);
});

test("invalid terminal requests fail without spawning and runtime shutdown owns cleanup", async t => {
  const { connect, runtime, processes, calls } = createFixture(t);
  const peer = connect();
  for (const payload of [
    { ...spawnRequest, file: "sh" }, { ...spawnRequest, args: [1] },
    { ...spawnRequest, env: { PATH: 1 } }, { ...spawnRequest, cols: 0 },
    { ...spawnRequest, cwd: "" }, { ...spawnRequest, meta: null },
  ]) assert.equal((await peer.request("terminal.spawn", payload)).ok, false);
  assert.equal(calls.length, 0);
  const { terminalId } = readResult(await peer.request("terminal.spawn", spawnRequest));
  assert.equal((await peer.request("terminal.write", { terminalId, data: 1 })).ok, false);
  assert.equal((await peer.request("terminal.resize", { terminalId, cols: -1, rows: 24 })).ok, false);
  for (const role of ["cli", "mcp"] as const) await assert.rejects(
    runtime.command({ type: "req", cmd_id: "direct", command: "terminal.list" }, role), /api role/);
  await runtime.close();
  assert.equal(processes[0].kills, 1);
  assert.equal(processes[0].data, undefined);
  assert.equal(processes[0].exit, undefined);
});
