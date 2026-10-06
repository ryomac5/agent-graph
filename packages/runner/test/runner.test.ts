import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, Socket } from "node:net";
import { once } from "node:events";
import { test, type TestContext } from "node:test";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { FakeHost, type StartRequest } from "../src/host/contract.ts";
import { Supervisor } from "../src/supervisor.ts";
import { serveSocket, RunnerProtocol, PROTOCOL_VERSION, type RunnerEvent } from "../src/socket.ts";
import { ledgerDbPath, runnerSocketPath } from "../src/paths.ts";
import { queryStatus } from "../src/cli.ts";

const request: StartRequest = { runId: "r1", conversationId: "c1", generation: 1, cwd: tmpdir(), input: { text: "test" }, model: { model: "fake" } };

function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "runner-"));
  const ledger = openLedger(join(directory, "test.db"));
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, ledger };
}

function readLines(socket: Socket) {
  let buffer = "";
  const lines: unknown[] = [];
  const waiters: ((value: any) => void)[] = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const value = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else lines.push(value);
    }
  });
  return () => lines.length ? Promise.resolve(lines.shift() as any) : new Promise<any>((resolve) => waiters.push(resolve));
}

async function connect(path: string, role = "api") {
  const socket = createConnection(path);
  const next = readLines(socket);
  await once(socket, "connect");
  socket.write(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, role }) + "\n");
  assert.deepEqual(await next(), { type: "hello", version: PROTOCOL_VERSION, role: "runner" });
  return { socket, next };
}

test("paths respect XDG and match the shared ledger location", () => {
  assert.equal(runnerSocketPath({}, "/home/test"), "/home/test/.local/state/agent-graph/runner.sock");
  assert.equal(ledgerDbPath({ XDG_STATE_HOME: "/state" }), "/state/agent-graph/agent-graph.db");
  assert.throws(() => runnerSocketPath({ XDG_STATE_HOME: "relative" }));
});

for (const exitCode of [0, 2]) {
  test(`host events append in order before notifications; exit ${exitCode}`, async (t) => {
    const { ledger } = createFixture(t);
    const notifications: RunnerEvent[] = [];
    const supervisor = new Supervisor(ledger, (event) => {
      if ("seq" in event) assert.equal(ledger.readSince(event.seq - 1, 1)[0].seq, event.seq);
      notifications.push(event);
    });
    const host = new FakeHost();
    supervisor.registerHost(host);
    await supervisor.start("claude", request);
    host.emit("r1", { type: "state", state: "running" });
    host.emit("r1", { type: "delta", text: "part" });
    host.emit("r1", { type: "fact", fact: { source_event_id: "message-1", source_ts: new Date(Date.now() + 100).toISOString(),
      kind: "message.created", subject: "message:m1", confidence: "confirmed",
      payload: { provider: "claude", native_id: "m1", version: 1, role: "assistant", body: "complete", body_state: "stored" } } });
    host.emit("r1", { type: "exit", exitCode });
    await supervisor.wait("r1");
    const facts = ledger.readSince(0, 100);
    assert.deepEqual(facts.filter((fact) => fact.kind === "run.created" || fact.kind === "run.state_changed").map((fact) => fact.payload?.state).filter(Boolean),
      ["starting", "running", exitCode === 0 ? "ended" : "failed"]);
    assert.equal(facts.at(-1)?.kind, "run.state_changed");
    assert.equal(facts.filter((fact) => fact.kind === "message.created").length, 1);
    assert.equal(notifications.filter((event) => "seq" in event).length, facts.length);
    assert.equal(notifications.filter((event) => "delta" in event).length, 1);
    assert.equal(projectRuns(facts)[0].state, exitCode === 0 ? "ended" : "failed");
    assert.deepEqual(supervisor.prepareUpdate(), { activeRuns: 0, activeDelegations: 0 });
  });
}

test("restart marks only managed live runs unknown and expires pending approvals", async (t) => {
  const { ledger } = createFixture(t);
  const supervisor = new Supervisor(ledger);
  const host = new FakeHost();
  supervisor.registerHost(host);
  await supervisor.start("claude", request);
  host.emit("r1", { type: "state", state: "waiting_approval" });
  host.emit("r1", { type: "fact", fact: { source_event_id: "approval-1", source_ts: new Date().toISOString(), kind: "approval.created",
    subject: "approval:a1", confidence: "confirmed", payload: { run_id: "r1", request_id: "a1", state: "pending" } } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const timestamp = new Date().toISOString();
  ledger.append({ source: "hook", source_event_id: "external-conversation", source_ts: timestamp, kind: "conversation.created",
    subject: "conversation:external", confidence: "confirmed", payload: { provider: "codex", native_id: "external", origin: "observed", type: "interactive", history_format: "jsonl" } });
  ledger.append({ source: "hook", source_event_id: "external-run", source_ts: timestamp, kind: "run.created", subject: "run:external",
    confidence: "confirmed", payload: { conversation_id: "external", generation: 1, state: "running" } });
  new Supervisor(ledger);
  const facts = ledger.readSince(0, 100);
  assert.equal(projectRuns(facts).find((run) => run.conversation_id === "c1")?.state, "unknown");
  assert.equal(projectRuns(facts).find((run) => run.conversation_id === "external")?.state, "running");
  assert.equal(facts.filter((fact) => fact.kind === "approval.resolved").findLast((fact) => fact.subject === "approval:a1")?.payload?.state, "expired");
  assert.equal(facts.filter((fact) => fact.kind === "run.state_changed" && fact.payload?.state === "ended").length, 0);
  host.emit("r1", { type: "exit", exitCode: 0 });
  await supervisor.wait("r1");
});

test("update rejects active runs and pending delegations", async (t) => {
  const { ledger } = createFixture(t);
  const supervisor = new Supervisor(ledger);
  const host = new FakeHost();
  supervisor.registerHost(host);
  await supervisor.start("claude", request);
  assert.deepEqual(supervisor.status(), { activeRuns: 1, activeDelegations: 0 });
  assert.throws(() => supervisor.prepareUpdate(), /blocked/);
  host.emit("r1", { type: "exit", exitCode: 0 });
  await supervisor.wait("r1");
  ledger.append({ source: "intake", source_event_id: "d1", source_ts: new Date().toISOString(), kind: "delegation.created", subject: "delegation:d1",
    confidence: "confirmed", payload: { request_id: "d1", role: "implementer", title: "test", attempt: 1, state: "running" } });
  assert.deepEqual(supervisor.status(), { activeRuns: 0, activeDelegations: 1 });
  assert.throws(() => supervisor.prepareUpdate(), /blocked/);
});

test("socket rejects incompatible hello and invalid roles", async (t) => {
  const { directory } = createFixture(t);
  const path = join(directory, "private", "runner.sock");
  let calls = 0;
  const server = await openTestSocket(t, path, () => { calls++; return null; });
  if (!server) return;
  t.after(() => server.close());
  assert.equal(statSync(join(directory, "private")).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const hello of [ { type: "hello", version: PROTOCOL_VERSION + 1, role: "api" },
    { type: "hello", version: PROTOCOL_VERSION, role: "intruder" }, { type: "req", cmd_id: "no-hello", command: "start" } ]) {
    const socket = createConnection(path);
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(JSON.stringify(hello) + "\n");
    await closed;
  }
  assert.equal(calls, 0);
});

test("concurrent cmd_id retries and reconnect return the same response once", async (t) => {
  const { directory } = createFixture(t);
  const path = join(directory, "runner.sock");
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const server = await openTestSocket(t, path, async () => { calls++; await gate; return { launched: calls }; });
  if (!server) return;
  t.after(() => server.close());
  const first = await connect(path);
  const second = await connect(path);
  const frame = JSON.stringify({ type: "req", cmd_id: "same", command: "start" }) + "\n";
  first.socket.write(frame + frame);
  second.socket.write(frame);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const response = await first.next();
  assert.equal(response.cmd_id, "same");
  assert.deepEqual(await first.next(), response);
  assert.deepEqual(await second.next(), response);
  first.socket.destroy(); second.socket.destroy();
  const third = await connect(path);
  third.socket.write(frame);
  assert.deepEqual(await third.next(), response);
  assert.equal(calls, 1);
  server.publish({ type: "evt", seq: 42 });
  assert.deepEqual(await third.next(), { type: "evt", seq: 42 });
  third.socket.destroy();
});

test("CLI status uses the runner socket", async (t) => {
  const { directory, ledger } = createFixture(t);
  const supervisor = new Supervisor(ledger);
  const path = join(directory, "runner.sock");
  const server = await openTestSocket(t, path, (request) => {
    assert.equal(request.command, "status");
    return { ...supervisor.status() };
  });
  if (!server) return;
  t.after(() => server.close());
  assert.deepEqual(await queryStatus(path), { activeRuns: 0, activeDelegations: 0 });
});

test("socket recovers a stale socket left by SIGKILL", { timeout: 10000 }, async (t) => {
  const { directory } = createFixture(t);
  const path = join(directory, "runner.sock");
  const probe = await openTestSocket(t, path, () => null);
  if (!probe) return;
  await probe.close();
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.send("ready"));', path],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child, "message");
  const stale = lstatSync(path);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  assert.equal(lstatSync(path).ino, stale.ino);

  const server = await serveSocket(path, () => ({ recovered: true }));
  t.after(() => server.close());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await queryStatus(path), { recovered: true });
});

test("socket refuses a second runner and preserves the live socket", async (t) => {
  const { directory } = createFixture(t);
  const path = join(directory, "runner.sock");
  const server = await openTestSocket(t, path, () => ({ original: true }));
  if (!server) return;
  t.after(() => server.close());
  const original = lstatSync(path);
  await assert.rejects(serveSocket(path, () => null), { code: "EADDRINUSE" });
  assert.equal(lstatSync(path).ino, original.ino);
  assert.deepEqual(await queryStatus(path), { original: true });
});

test("socket recovery preserves regular files and symlinks", async (t) => {
  const { directory } = createFixture(t);
  const path = join(directory, "runner.sock");
  const probe = await openTestSocket(t, path, () => null);
  if (!probe) return;
  await probe.close();
  const file = join(directory, "file.sock");
  const link = join(directory, "link.sock");
  writeFileSync(file, "keep");
  symlinkSync(file, link);
  for (const occupied of [file, link]) {
    const original = lstatSync(occupied);
    await assert.rejects(serveSocket(occupied, () => null));
    assert.equal(lstatSync(occupied).ino, original.ino);
  }
  assert.equal(readFileSync(file, "utf8"), "keep");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

async function openTestSocket(t: TestContext, ...args: Parameters<typeof serveSocket>) {
  try { return await serveSocket(...args); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") throw error;
    t.skip("Unix socket listen is denied by the sandbox; run this integration test outside it");
  }
}

function createPeer(t: TestContext, protocol: RunnerProtocol) {
  const socket = new Socket();
  const output: any[] = [];
  t.mock.method(socket, "write", (line: string) => { output.push(JSON.parse(line)); return true; });
  protocol.attach(socket);
  t.after(() => socket.destroy());
  const send = (message: unknown) => socket.emit("data", JSON.stringify(message) + "\n");
  return { socket, output, send };
}

test("protocol checks hello version and role before accepting commands", (t) => {
  let calls = 0;
  const protocol = new RunnerProtocol(() => { calls++; return null; });
  for (const message of [
    { type: "hello", version: 0, role: "api" },
    { type: "hello", version: PROTOCOL_VERSION, role: "invalid" },
    { type: "req", cmd_id: "early", command: "start" },
    null,
  ]) {
    const peer = createPeer(t, protocol);
    peer.send(message);
    assert.equal(peer.socket.destroyed, true);
    assert.deepEqual(peer.output, []);
  }
  for (const role of ["api", "mcp", "cli"]) {
    const peer = createPeer(t, protocol);
    peer.send({ type: "hello", version: PROTOCOL_VERSION, role });
    assert.deepEqual(peer.output, [{ type: "hello", version: PROTOCOL_VERSION, role: "runner" }]);
  }
  assert.equal(calls, 0);
});

test("protocol deduplicates in-flight retries across connections and publishes events", async (t) => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const protocol = new RunnerProtocol(async () => { calls++; await gate; return { launched: calls }; });
  const first = createPeer(t, protocol);
  const second = createPeer(t, protocol);
  for (const peer of [first, second]) peer.send({ type: "hello", version: PROTOCOL_VERSION, role: "api" });
  const command = { type: "req", cmd_id: "same", command: "start" };
  const frame = JSON.stringify(command) + "\n";
  first.socket.emit("data", frame.slice(0, 10));
  first.socket.emit("data", frame.slice(10) + frame);
  second.send(command);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const response = { type: "res", cmd_id: "same", ok: true, result: { launched: 1 } };
  assert.deepEqual(first.output.slice(1), [response, response]);
  assert.deepEqual(second.output.slice(1), [response]);
  first.socket.destroy(); second.socket.destroy();
  const third = createPeer(t, protocol);
  third.send({ type: "hello", version: PROTOCOL_VERSION, role: "api" });
  third.send(command);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(third.output[1], response);
  assert.equal(calls, 1);
  protocol.publish({ type: "evt", seq: 42 });
  protocol.publish({ type: "evt", delta: { runId: "r1", text: "part" } });
  assert.deepEqual(third.output.slice(2), [{ type: "evt", seq: 42 }, { type: "evt", delta: { runId: "r1", text: "part" } }]);
});

test("protocol returns and caches command failures", async (t) => {
  let calls = 0;
  const protocol = new RunnerProtocol(() => { calls++; throw new Error("rejected"); });
  const peer = createPeer(t, protocol);
  peer.send({ type: "hello", version: PROTOCOL_VERSION, role: "cli" });
  const command = { type: "req", cmd_id: "failure", command: "start" };
  peer.send(command); peer.send(command);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(peer.output.slice(1), [
    { type: "res", cmd_id: "failure", ok: false, error: "rejected" },
    { type: "res", cmd_id: "failure", ok: false, error: "rejected" },
  ]);
});

test("stream completion without an exit code preserves unknown state", async (t) => {
  const { ledger } = createFixture(t);
  const host = new FakeHost();
  t.mock.method(host, "start", async (request: StartRequest) => ({ runId: request.runId, nativeId: "native",
    events: (async function* () { yield { type: "state" as const, state: "running" as const }; })() }));
  const supervisor = new Supervisor(ledger);
  supervisor.registerHost(host);
  await supervisor.start("claude", request);
  await supervisor.wait("r1");
  const run = projectRuns(ledger.readSince(0, 100))[0];
  assert.equal(run.state, "unknown");
  assert.equal(run.reason, "host_stream_closed_without_exit");
});

test("preparing an update stops further launches", async (t) => {
  const { ledger } = createFixture(t);
  const supervisor = new Supervisor(ledger);
  supervisor.registerHost(new FakeHost());
  supervisor.prepareUpdate();
  await assert.rejects(supervisor.start("claude", request), /preparing an update/);
  assert.equal(ledger.readSince(0, 100).length, 0);
});
