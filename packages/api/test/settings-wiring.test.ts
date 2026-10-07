import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { openObservationService } from "../src/service/index.ts";
import { SettingsService, settingsPaths } from "../src/settings/index.ts";
import { createKeychain } from "../src/settings/keychain.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import type { RunnerResponse } from "../src/runner-client.ts";

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) { assert.ok(Date.now() < deadline, "Timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function waitForConfigError(read: () => Promise<RunnerResponse>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = await read();
    if (response.ok) {
      const result = response.result as { errors?: { config?: string } };
      if (result.errors?.config === "Invalid config.dashboard.port") return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Watched validation error must reach the screen cmd");
}

test("authenticated screen cmds read, preview and atomically save Settings; watched invalid edits retain runtime", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "settings-wiring-"));
  const observation = openObservationService({ dbPath: join(root, "ledger.db") });
  const paths = settingsPaths(root, { XDG_CONFIG_HOME: root });
  const applied: string[] = [];
  let key: string | undefined;
  const settings = new SettingsService({ paths, ledger: observation.ledger,
    keychain: { async setClaudeApiKey(value) { key = value; }, async deleteClaudeApiKey() { key = undefined; }, async hasClaudeApiKey() { return !!key; } },
    history: () => [{ id: "past", request: { role: "implement", title: "task", task: "task", accept: [] }, context: { quota: () => undefined, performance: () => undefined } }],
    async apply(store) { applied.push(store); },
    async status() { return { hosts: { claude: { state: "unknown", version: null, authentication: null, degraded: [] }, codex: { state: "unknown", version: null, authentication: null, degraded: [] } }, connection: { runner: false, protocolVersion: 1, apiVersion: "2", updatePending: false }, observation: { formats: [], unsupportedCount: 0 }, rebuild: { state: "idle", completed: 0, total: 0 }, logs: { runner: "runner.log", api: "api.log" } }; },
    async listModels() { throw new Error("Unavailable"); }, async rebuild(progress) { progress(0, 1); observation.rebuild(); progress(1, 1); }, resync() { server?.resync(); },
  });
  let server: Awaited<ReturnType<typeof startWebSocketServer>> | undefined;
  let socket: WebSocket | undefined;
  try {
    await settings.start();
    try { server = await startWebSocketServer(observation, { port: 0, runnerPath: join(root, "absent.sock"), settings }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM" && "syscall" in error && error.syscall === "listen")) throw error;
      t.skip("sandbox blocks local socket listen"); return;
    }
    const acks = new Map<string, RunnerResponse>();
    socket = new WebSocket(`${server.wsUrl}?token=${server.token}`, { origin: server.url });
    socket.on("message", data => { const message = JSON.parse(data.toString()); if (message.type === "ack") acks.set(message.cmd_id, message); });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", seq: 0 }));
    let counter = 0;
    async function command(command: string, payload?: unknown) {
      const cmd_id = `settings-test-${++counter}`;
      socket!.send(JSON.stringify({ type: "cmd", cmd_id, command, payload }));
      await waitUntil(() => acks.has(cmd_id));
      return acks.get(cmd_id)!;
    }
    assert.equal((await command("settings.read")).ok, true);
    assert.equal((await command("settings.write", { store: "config", patch: { dashboard: { port: 7541 } } })).ok, true);
    const original = await readFile(paths.config, "utf8");
    const inode = (await stat(paths.config)).ino;
    assert.equal((await command("settings.write", { store: "config", patch: { dashboard: { port: -1 } } })).ok, false);
    assert.equal(await readFile(paths.config, "utf8"), original);
    assert.equal((await command("settings.write", { store: "config", patch: { dashboard: { port: 7542 } } })).ok, true);
    assert.notEqual((await stat(paths.config)).ino, inode);
    assert.equal((await command("settings.write", { store: "project", patch: { scope: { exclude: ["private"] } } })).ok, true);
    const patch = { quota: { hardLimitPercent: 95 } };
    assert.equal((await command("settings.write", { store: "policy", patch })).ok, false);
    const preview = await command("settings.previewPolicy", { patch });
    assert.ok(preview.ok);
    const previewToken = (preview.result as { token: string }).token;
    assert.equal((await command("settings.write", { store: "policy", patch, previewToken })).ok, true);
    assert.match(await readFile(paths.policy, "utf8"), /95/);
    await writeFile(paths.config, '[dashboard]\nport = -1\n');
    await waitForConfigError(() => command("settings.read"));
    assert.equal(settings.read("config").dashboard.port, 7542);
    await writeFile(paths.config, '[dashboard]\nport = 7543\n');
    await waitUntil(() => settings.read("config").dashboard.port === 7543);
    const secret = "never-show-this-key";
    assert.equal((await command("settings.apiKey", { value: secret })).ok, true);
    assert.ok(!JSON.stringify(await command("settings.read")).includes(secret));
    const facts = observation.ledger.readSince(0, 100);
    assert.ok(facts.some(fact => fact.kind === "setting.changed" && fact.payload?.origin === "file"));
    assert.ok(!JSON.stringify(facts).includes(secret));
    assert.deepEqual(new Set(applied), new Set(["config", "policy", "project"]));
  } finally { socket?.terminate(); await server?.close(); settings.close(); observation.close(); await rm(root, { recursive: true, force: true }); }
});

test("Keychain passes values only through stdin, checks presence without reading keys, and sanitizes failures", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  let code = 0;
  const keychain = createKeychain(async (args, input) => { calls.push({ args, input }); return code; });
  const value = 'private"key\\quoted';
  await keychain.setClaudeApiKey(value);
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.match(calls[0].input!, /^add-generic-password -U/);
  assert.ok(calls[0].input!.includes('private\\"key\\\\quoted'));
  assert.equal(await keychain.hasClaudeApiKey(), true);
  assert.ok(!calls[1].args.includes("-w")); assert.equal(calls[1].input, undefined);
  code = 44; assert.equal(await keychain.hasClaudeApiKey(), false); await keychain.deleteClaudeApiKey();
  assert.equal(calls.at(-1)!.args[0], "delete-generic-password");
  code = 1;
  await assert.rejects(keychain.setClaudeApiKey(value), /^Error: Keychain unavailable$/);
  await assert.rejects(keychain.hasClaudeApiKey(), /^Error: Keychain unavailable$/);
  await assert.rejects(keychain.deleteClaudeApiKey(), /^Error: Keychain unavailable$/);
  await assert.rejects(keychain.setClaudeApiKey('key\nhelp'), /Invalid API key/);
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes(value)));
});

test("Keychain rejects control characters and oversized interactive input before executing", async () => {
  let calls = 0;
  const keychain = createKeychain(async () => { calls++; return 0; });
  for (const value of [' ', 'key\tcommand', 'key\x7f', 'x'.repeat(4096), '"'.repeat(2048), '鍵'.repeat(1400)]) {
    await assert.rejects(keychain.setClaudeApiKey(value), /^Error: Invalid API key$/);
  }
  assert.equal(calls, 0);
  const failing = createKeychain(async () => { throw new Error("private-key-in-process-error"); });
  await assert.rejects(failing.setClaudeApiKey("private-key"), /^Error: Keychain unavailable$/);
});

test("serve wiring uses its own audit writer and the runner socket transport, including cmd read/write", async () => {
  const { createServeSettings } = await import("../src/ws/settings.ts");
  const { bindSettingsRequests } = await import("../src/settings/websocket.ts");
  const { forwardScreenCommand } = await import("../src/ws/commands.ts");
  const root = await mkdtemp(join(tmpdir(), "serve-settings-"));
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const observation = openObservationService({ dbPath: join(root, "ledger.db"), readerOnly: true });
  const commands: string[] = [];
  let resyncs = 0;
  const runner = { available: true, async request(request: import("../src/runner-client.ts").RunnerRequest): Promise<RunnerResponse> {
    commands.push(request.command);
    return { type: "res", cmd_id: request.cmd_id, ok: true, result: { [request.command === "runner.settings.preflight" ? "valid" : "applied"]: true } };
  } };
  const configured = createServeSettings(observation, { repository: root, runner: runner as unknown as import("../src/runner-client.ts").RunnerClient,
    keychain: createKeychain(async args => args[0] === "find-generic-password" ? 44 : 0), resync() { resyncs++; } });
  const detach = bindSettingsRequests(runner, configured.settings);
  try {
    await configured.settings.start();
    const read = await runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "read-serve", command: "settings.read" }));
    assert.ok(read.ok); assert.ok(JSON.stringify(read).includes('"apiKeyConfigured":false'));
    const response = await runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "save-serve", command: "settings.write", payload: { store: "config", patch: { dashboard: { port: 7561 } } } }));
    assert.ok(response.ok);
    assert.equal(configured.settings.read("config").dashboard.port, 7561);
    assert.match(await readFile(settingsPaths(root).config, "utf8"), /7561/);
    assert.ok(observation.ledger.readSince(0, 100).some(fact => fact.kind === "setting.changed"));
    assert.ok(commands.includes("runner.settings.preflight")); assert.ok(commands.includes("runner.settings.apply"));
    assert.ok(!commands.includes("settings.write"));
    const rebuilt = await runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "rebuild-serve", command: "settings.rebuild" }));
    assert.ok(rebuilt.ok);
    await waitUntil(() => resyncs === 1);
    const status = await runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "status-serve", command: "settings.status" }));
    assert.ok(status.ok);
    assert.equal((status.result as { rebuild: { state: string } }).rebuild.state, "done");
    // listen が禁止された環境でも、serve の cmd 経路で監視の拒否と回復を確認する。
    await writeFile(settingsPaths(root).config, '[dashboard]\nport = -1\n');
    await waitForConfigError(() => runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "watched-read", command: "settings.read" })));
    assert.equal(configured.settings.read("config").dashboard.port, 7561);
    await writeFile(settingsPaths(root).config, '[dashboard]\nport = 7562\n');
    await waitUntil(() => configured.settings.read("config").dashboard.port === 7562);
    const recovered = await runner.request(forwardScreenCommand({ type: "cmd", cmd_id: "recovered-read", command: "settings.read" }));
    assert.ok(recovered.ok);
    assert.deepEqual((recovered.result as { errors: unknown }).errors, {});
    assert.ok(observation.ledger.readSince(0, 100).some(fact => fact.kind === "setting.changed" && fact.payload?.origin === "file"));
    await runner.request({ type: "req", cmd_id: "non-settings", command: "intake.status" });
    assert.equal(commands.at(-1), "intake.status");
  } finally {
    detach(); configured.close(); observation.close();
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfigHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("serve reads the saved API port and falls back on invalid manual configuration", async () => {
  const { readServePort } = await import("../src/ws/settings.ts");
  const { DEFAULT_SETTINGS_PORT } = await import("../../core/src/settings/index.ts");
  const root = await mkdtemp(join(tmpdir(), "serve-port-"));
  const oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    assert.equal(readServePort(root), DEFAULT_SETTINGS_PORT);
    const paths = settingsPaths(root);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "agent-graph"));
    await writeFile(paths.config, '[dashboard]\nport = 7565\n');
    assert.equal(readServePort(root), 7565);
    await writeFile(paths.config, '[dashboard]\nport = -1\n');
    assert.equal(readServePort(root), DEFAULT_SETTINGS_PORT);
  } finally {
    if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfigHome;
    await rm(root, { recursive: true, force: true });
  }
});
