import assert from "node:assert/strict";
import { test } from "node:test";
import { createTerminalRegistry, MAX_SCROLLBACK_BYTES, MAX_TERMINALS,
  type TerminalExit, type TerminalProcess, type TerminalRegistryOptions } from "../src/terminals/index.ts";
import { filterTerminalEnv } from "../src/terminals/spawn.ts";

function createFakeTerminal(pid: number) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: TerminalExit) => void>();
  const writes: (string | Buffer)[] = [];
  const sizes: number[][] = [];
  let kills = 0;
  const terminal: TerminalProcess = {
    pid,
    write(data) { writes.push(data); },
    resize(cols, rows) { sizes.push([cols, rows]); },
    kill() { kills++; for (const listener of exitListeners) listener({ exitCode: 0, signal: 15 }); },
    onData(listener) { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener); } }; },
    onExit(listener) { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener); } }; },
  };
  return {
    terminal, writes, sizes,
    get kills() { return kills; },
    get listeners() { return dataListeners.size + exitListeners.size; },
    emitData(data: string) { for (const listener of dataListeners) listener(data); },
    emitExit(exit: TerminalExit) { for (const listener of exitListeners) listener(exit); },
  };
}

function createFixture() {
  const calls: Parameters<NonNullable<TerminalRegistryOptions["openTerminal"]>>[] = [];
  const processes: ReturnType<typeof createFakeTerminal>[] = [];
  const registry = createTerminalRegistry({ openTerminal(...args) {
    calls.push(args);
    const process = createFakeTerminal(100 + processes.length);
    processes.push(process);
    return process.terminal;
  } });
  const request = { file: "claude", args: ["--resume", "session"], cwd: "/work/project", env: { PATH: "/bin" },
    cols: 80, rows: 24, meta: { provider: "claude", projectId: "project", target: { type: "local" } } };
  return { registry, calls, processes, request };
}

test("spawn passes arguments and keeps stable identity, metadata and start time in memory", () => {
  const { registry, calls, processes, request } = createFixture();
  const before = Date.now();
  const first = registry.spawn(request);
  assert.equal(first.pid, 100);
  assert.match(first.terminalId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls, [["claude", request.args, {
    cwd: request.cwd, env: { PATH: "/bin", TERM: "xterm-256color" }, name: "xterm-256color", cols: 80, rows: 24,
  }]]);
  const [info] = registry.list();
  assert.deepEqual(info, { ...first, meta: request.meta, startedAt: info.startedAt, scrollback: "" });
  assert.ok(Date.parse(info.startedAt) >= before && Date.parse(info.startedAt) <= Date.now());
  request.meta.target.type = "changed";
  (info.meta.target as { type: string }).type = "also changed";
  assert.deepEqual(registry.list()[0].meta.target, { type: "local" });
  registry.write(first.terminalId, "hello\r");
  registry.resize(first.terminalId, 120, 40);
  assert.deepEqual(processes[0].writes, ["hello\r"]);
  assert.deepEqual(processes[0].sizes, [[120, 40]]);
  const second = registry.spawn({ ...request, file: "codex" });
  const third = registry.spawn({ ...request, file: "ssh", args: ["-tt", "host", "claude"] });
  assert.equal(new Set([first.terminalId, second.terminalId, third.terminalId]).size, 3);
  registry.dispose();
});

test("only exact claude, codex and ssh executable names may spawn", () => {
  const { registry, calls, request } = createFixture();
  for (const file of ["sh", "zsh", "/bin/sh", "/usr/local/bin/claude", "./codex", "claude --help", "SSH", "", "ssh\0"])
    assert.throws(() => registry.spawn({ ...request, file }), /executable/);
  assert.equal(calls.length, 0);
});

test("environment filtering removes all reserved prefixes without mutating input", () => {
  const { registry, calls, request } = createFixture();
  const env = { PATH: "/safe/bin", TERM: "vt100", AGENT_GRAPH: "secret", AGENT_GRAPH_TOKEN: "secret",
    AGENT_GRAPHOTHER: "secret", CLAUDE_CODE: "secret", CLAUDE_CODE_SESSION: "secret",
    CLAUDE_CODEOTHER: "secret", CLAUDECODE: "secret", CLAUDE_CONFIG_DIR: "/config", EMPTY: "", UNSET: undefined };
  const expected = { PATH: "/safe/bin", TERM: "vt100", CLAUDE_CONFIG_DIR: "/config", EMPTY: "" };
  registry.spawn({ ...request, env });
  assert.deepEqual(calls[0][2]?.env, expected);
  assert.equal(calls[0][2]?.name, "vt100");
  // PTY の包みでも同じフィルタを適用し、注入された env の再混入を防ぐ。
  assert.deepEqual(filterTerminalEnv(env), expected);
  assert.equal(env.AGENT_GRAPH_TOKEN, "secret");
  registry.dispose();
});

test("output and exit listeners can detach and later reattach to the same terminal", () => {
  const { registry, processes, request } = createFixture();
  const { terminalId } = registry.spawn(request);
  const outputs: unknown[] = [], exits: unknown[] = [];
  const data = registry.onData(event => outputs.push(event));
  const exit = registry.onExit(event => exits.push(event));
  processes[0].emitData("before");
  data.dispose(); exit.dispose();
  processes[0].emitData(" offline");
  assert.deepEqual(outputs, [{ terminalId, data: "before" }]);
  assert.equal(registry.list()[0].scrollback, "before offline");
  registry.onData(event => outputs.push(event));
  registry.onExit(event => exits.push(event));
  registry.write(terminalId, "reconnected\r");
  processes[0].emitData(" after");
  processes[0].emitExit({ exitCode: 7, signal: 9 });
  assert.deepEqual(outputs.at(-1), { terminalId, data: " after" });
  assert.deepEqual(exits, [{ terminalId, exitCode: 7, signal: 9 }]);
  assert.deepEqual(registry.list()[0].exited, { exitCode: 7, signal: 9 });
  assert.equal(registry.list()[0].scrollback, "before offline after");
  processes[0].emitExit({ exitCode: 0 });
  processes[0].emitData("late");
  assert.equal(exits.length, 1);
  assert.equal(registry.list()[0].scrollback, "before offline after");
  assert.throws(() => registry.write(terminalId, "input"), /exited/);
  assert.throws(() => registry.resize(terminalId, 80, 24), /exited/);
  registry.kill(terminalId);
  assert.deepEqual(registry.list(), []);
  assert.equal(processes[0].kills, 0);
  assert.equal(processes[0].listeners, 0);
});

test("scrollback is a 256 KiB byte ring retaining the newest output through wraparound", () => {
  const { registry, processes, request } = createFixture();
  registry.spawn(request);
  let expected = "";
  for (const chunk of ["a".repeat(MAX_SCROLLBACK_BYTES - 3), "bcdefg", "h".repeat(MAX_SCROLLBACK_BYTES + 10), "tail"]) {
    processes[0].emitData(chunk);
    expected = (expected + chunk).slice(-MAX_SCROLLBACK_BYTES);
    assert.equal(registry.list()[0].scrollback, expected);
    assert.equal(Buffer.byteLength(registry.list()[0].scrollback), Math.min(MAX_SCROLLBACK_BYTES, expected.length));
  }
  registry.dispose();
});

test("scrollback respects the byte limit and trims incomplete UTF-8 at the oldest boundary", () => {
  const { registry, processes, request } = createFixture();
  registry.spawn(request);
  processes[0].emitData("日".repeat(MAX_SCROLLBACK_BYTES));
  let text = registry.list()[0].scrollback;
  assert.equal(text, "日".repeat(Math.floor(MAX_SCROLLBACK_BYTES / 3)));
  processes[0].emitData("本語");
  text = registry.list()[0].scrollback;
  assert.equal(text, "日".repeat(Math.floor(MAX_SCROLLBACK_BYTES / 3) - 2) + "本語");
  assert.ok(Buffer.byteLength(text) <= MAX_SCROLLBACK_BYTES);
  assert.ok(!text.includes("\ufffd"));
  registry.dispose();
});

test("eight retained terminals fill the registry until kill or explicit dispose removes one", () => {
  const { registry, calls, processes, request } = createFixture();
  const ids = Array.from({ length: MAX_TERMINALS }, () => registry.spawn(request).terminalId);
  assert.throws(() => registry.spawn(request), /limit/);
  processes[0].emitExit({ exitCode: 0 });
  assert.throws(() => registry.spawn(request), /limit/);
  assert.equal(calls.length, 8);
  registry.dispose(ids[0]);
  registry.spawn(request);
  registry.kill(ids[1]);
  assert.equal(processes[1].kills, 1);
  assert.equal(processes[1].listeners, 0);
  registry.spawn(request);
  registry.dispose();
  assert.deepEqual(registry.list(), []);
  assert.ok(processes.every(process => process.listeners === 0));
  assert.ok(processes.slice(1).every(process => process.kills === 1));
  registry.dispose();
  assert.throws(() => registry.spawn(request), /disposed/);
});

test("invalid sizes and unknown IDs do not touch a PTY", () => {
  const { registry, calls, processes, request } = createFixture();
  for (const size of [0, -1, 1.5, NaN, Infinity, 65536]) {
    assert.throws(() => registry.spawn({ ...request, cols: size }), /size/);
    assert.throws(() => registry.spawn({ ...request, rows: size }), /size/);
  }
  assert.equal(calls.length, 0);
  const { terminalId } = registry.spawn(request);
  assert.throws(() => registry.resize(terminalId, 0, 24), /size/);
  assert.deepEqual(processes[0].sizes, []);
  registry.resize(terminalId, 1, 65535);
  assert.deepEqual(processes[0].sizes, [[1, 65535]]);
  for (const action of [() => registry.write("missing", "x"), () => registry.resize("missing", 80, 24),
    () => registry.kill("missing"), () => registry.dispose("missing")]) assert.throws(action, /Unknown terminal/);
  registry.dispose();
});

test("a failed spawn does not consume a slot or create a registry entry", () => {
  const fake = createFakeTerminal(123);
  let fail = true;
  const registry = createTerminalRegistry({ openTerminal() {
    if (fail) throw new Error("spawn failed");
    return fake.terminal;
  } });
  const { request } = createFixture();
  assert.throws(() => registry.spawn(request), /spawn failed/);
  assert.deepEqual(registry.list(), []);
  fail = false;
  assert.equal(registry.spawn(request).pid, 123);
  registry.dispose();
});

test("individual disposal leaves other terminals and their output listeners active", () => {
  const { registry, processes, request } = createFixture();
  const first = registry.spawn(request), second = registry.spawn({ ...request, file: "codex" });
  const output: unknown[] = [];
  registry.onData(event => output.push(event));
  processes[0].emitData("first");
  processes[1].emitData("second");
  assert.deepEqual(registry.list().map(info => info.scrollback), ["first", "second"]);
  registry.dispose(first.terminalId);
  processes[0].emitData("removed");
  processes[1].emitData(" alive");
  assert.equal(processes[0].kills, 1);
  assert.equal(processes[0].listeners, 0);
  assert.equal(processes[1].kills, 0);
  assert.equal(registry.list()[0].terminalId, second.terminalId);
  assert.equal(registry.list()[0].scrollback, "second alive");
  assert.deepEqual(output, [{ terminalId: first.terminalId, data: "first" },
    { terminalId: second.terminalId, data: "second" }, { terminalId: second.terminalId, data: " alive" }]);
  registry.dispose();
});
