import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { startShim, RECONNECT_MAX_MS, UNAVAILABLE_TIMEOUT_MS } from "../src/shim-v2/index.ts";
import { fixture, messages, pair, until } from "../../runner/test/samples/S13/fixture.ts";
import { projectDelegations } from "../../core/src/ledger/projections/delegations.ts";

const samples: string[] = JSON.parse(readFileSync(new URL("../../runner/test/samples/S13/input.json", import.meta.url), "utf8"));
const expected = JSON.parse(readFileSync(new URL("../../runner/test/samples/S13/expected.json", import.meta.url), "utf8"));

test("initial tools/list waits for connection after initialize and returns all three tools", async (t) => {
  const f = fixture(t);
  const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  const [client, server] = pair();
  f.protocol.attach(server);
  const shim = startShim({ path: "memory", input, output, connect: () => client });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize" }) + "\n");
  await until(() => replies.some((r) => r.id === "initialize"));
  input.write(JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!replies.some((r) => r.id === "list"));
  client.emit("connect");
  await until(() => replies.some((r) => r.id === "list"));
  assert.deepEqual(replies.find((r) => r.id === "list").result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["delegate", "status", "wait"]);
});

for (const fault of samples) test(`S13: ${fault}`, async (t) => {
  const f = fixture(t);
  const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  let available = fault !== "runner-absent";
  let current: Socket;
  let lost = false;
  let api: Socket | undefined;
  const submissions: string[] = [];
  const calls: string[] = [];
  const shim = startShim({ path: "memory", input, output, env: { CODEX_THREAD_ID: "parent-thread" }, reconnectInitialMs: 2,
    unavailableTimeoutMs: 1000, connect() {
      const [client, server] = pair(); current = client;
      if (!available) { queueMicrotask(() => client.destroy()); return client; }
      const write = server.write.bind(server);
      server.write = ((line: string, ...args: any[]) => {
        const message = JSON.parse(String(line));
        if (!lost && fault === "disconnected-after-acceptance" && message.result?.structuredContent?.state === "accepted") {
          lost = true; server.destroy(); return true;
        }
        if (!lost && fault === "response-lost-after-result" && message.result?.structuredContent?.state === "failed") {
          lost = true; server.destroy(); return true;
        }
        return write(line, ...args);
      }) as typeof server.write;
      server.on("data", (chunk) => {
        for (const line of String(chunk).trim().split("\n")) {
          const message = JSON.parse(line);
          if (message.method === "tools/call") {
            calls.push(message.params.name);
            if (message.params.name === "delegate") submissions.push(message.params.arguments.requestId);
          }
        }
      });
      f.protocol.attach(server);
      queueMicrotask(() => client.emit("connect")); return client;
    } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); api?.destroy(); });
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  // tools/list の応答を受け、接続済みであることを確かめる。
  if (fault !== "runner-absent") {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    send({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    await until(() => replies.some((r) => r.id === "list"));
    assert.equal(replies.find((r) => r.id === "list").result.tools.length, 3);
  }
  if (fault === "stopped-after-connect") {
    available = false; current!.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  send({ jsonrpc: "2.0", id: "delegate", method: "tools/call", params: { name: "delegate", arguments: f.request } });
  if (!available) { await new Promise<void>((resolve) => setTimeout(resolve, 10)); available = true; }
  await until(() => replies.some((r) => r.id === "delegate"));
  const accepted = replies.find((r) => r.id === "delegate").result.structuredContent;
  const requestId = accepted.requestId;
  assert.ok(["accepted", "running"].includes(accepted.state));
  await until(() => f.host.starts.length === 1);
  assert.equal(new Set(submissions).size, 1);
  assert.ok(submissions.every((id) => id === requestId));
  const stored = f.ledger.readSince(0, 1000).find((fact) => fact.kind === "delegation.created")!;
  assert.deepEqual((stored.payload as any).request.origin, { provider: "codex", nativeId: "parent-thread" });
  if (fault === "api-restart") {
    const first = f.connect(); api = first.client; const events = messages(api);
    api.write(JSON.stringify({ type: "hello", role: "api", version: 1 }) + "\n");
    await until(() => events.some((e) => e.type === "hello"));
    const before = f.ledger.readSince(0, 1000); const seq = before.at(-1)!.seq;
    api.destroy();
    f.host.emit(f.host.starts[0].runId, { type: "exit", exitCode: 0 });
    await f.intake.wait(requestId);
    const restarted = f.connect(); api = restarted.client; const recovered = messages(api);
    api.write(JSON.stringify({ type: "hello", role: "api", version: 1 }) + "\n");
    api.write(JSON.stringify({ type: "req", cmd_id: "after-restart", command: "intake.status", payload: { requestId } }) + "\n");
    await until(() => recovered.some((r) => r.cmd_id === "after-restart"));
    assert.equal(recovered.find((r) => r.cmd_id === "after-restart").result.state, "failed");
    const resumed = [...before, ...f.ledger.readSince(seq, 1000)];
    assert.deepEqual(projectDelegations(resumed), projectDelegations(f.ledger.readSince(0, 1000)));
    assert.equal(new Set(resumed.map((fact) => fact.seq)).size, resumed.length);
  }
  send({ jsonrpc: "2.0", id: "wait", method: "tools/call", params: { name: "wait", arguments: { requestId }, _meta: { progressToken: "s13" } } });
  if (fault !== "api-restart") {
    await until(() => replies.some((r) => r.method === "notifications/progress"));
    f.host.emit(f.host.starts[0].runId, { type: "exit", exitCode: 0 });
  }
  await until(() => replies.some((r) => r.id === "wait"));
  const final = replies.find((r) => r.id === "wait").result.structuredContent;
  assert.equal(final.state, expected.terminalState);
  assert.ok(final.result);
  const progress = replies.filter((r) => r.method === "notifications/progress");
  assert.ok(progress.every((r, index) => index === 0 || r.params.progress > progress[index - 1].params.progress));
  send({ jsonrpc: "2.0", id: "status", method: "tools/call", params: { name: "status", arguments: { requestId } } });
  await until(() => replies.some((r) => r.id === "status"));
  assert.deepEqual(replies.find((r) => r.id === "status").result.structuredContent, final);
  assert.deepEqual(f.intake.submit({ ...(stored.payload as any).request }), final);
  assert.equal(f.host.starts.length, expected.implementerStarts);
  assert.equal(projectDelegations(f.ledger.readSince(0, 1000)).length, expected.delegations);
  if (fault === "disconnected-after-acceptance" || fault === "response-lost-after-result") assert.equal(lost, true);
  if (fault === "response-lost-after-result") { assert.equal(submissions.length, 1); assert.ok(calls.filter((name) => name === "status").length >= 2); }
});

test("unavailable calls and uncached tools time out explicitly; stdio and reconnection survive", async (t) => {
  const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  let attempts = 0;
  const shim = startShim({ path: "missing", input, output, reconnectInitialMs: 2, reconnectMaxMs: 8, unavailableTimeoutMs: 25,
    connect() { attempts++; const [socket] = pair(); queueMicrotask(() => socket.destroy()); return socket; } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "status", arguments: { requestId: "missing" } } }) + "\n");
  await until(() => replies.some((r) => r.id === 1));
  assert.equal(replies[0].error.code, -32001);
  assert.match(replies[0].error.message, /unavailable/);
  assert.equal(output.destroyed, false); assert.equal(input.destroyed, false);
  const before = attempts;
  await new Promise<void>((resolve) => setTimeout(resolve, 20)); assert.ok(attempts > before);
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  assert.ok(!replies.some((r) => r.id === 2));
  await until(() => replies.some((r) => r.id === 2));
  assert.equal(replies.find((r) => r.id === 2).error.code, -32001);
  assert.match(replies.find((r) => r.id === 2).error.message, /unavailable/);
  assert.equal(RECONNECT_MAX_MS, 5000); assert.equal(UNAVAILABLE_TIMEOUT_MS, 30_000);
});

test("cached tools remain available offline and acknowledged delegate is only reconciled by status", async (t) => {
  const f = fixture(t); const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  let available = true; let current: Socket; const calls: string[] = [];
  const shim = startShim({ path: "memory", input, output, reconnectInitialMs: 2,
    connect() {
      const [client, server] = pair(); current = client;
      if (!available) { queueMicrotask(() => client.destroy()); return client; }
      server.on("data", (chunk) => { for (const line of String(chunk).trim().split("\n")) {
        const message = JSON.parse(line); if (message.method === "tools/call") calls.push(message.params.name);
      } });
      f.protocol.attach(server); queueMicrotask(() => client.emit("connect")); return client;
    } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delegate", arguments: f.request } }) + "\n");
  await until(() => replies.some((r) => r.id === 1));
  available = false; current!.destroy(); await new Promise<void>((resolve) => setTimeout(resolve, 5));
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await until(() => replies.some((r) => r.id === 2)); assert.equal(replies.find((r) => r.id === 2).result.tools.length, 3);
  available = true; await until(() => calls.includes("status")); assert.equal(calls.filter((name) => name === "delegate").length, 1);
});

for (const [name, env, expectedOrigin] of [
  ["claude", { CLAUDE_CODE_SESSION_ID: "claude-parent", CODEX_THREAD_ID: "codex-parent" }, { provider: "claude", nativeId: "claude-parent" }],
  ["codex", { CLAUDE_CODE_SESSION_ID: "claude-parent", CODEX_THREAD_ID: "codex-parent" }, { provider: "codex", nativeId: "codex-parent" }],
  ["unknown", { CLAUDE_CODE_SESSION_ID: "claude-parent", CODEX_THREAD_ID: "codex-parent" }, undefined],
  ["claude", { AGENT_GRAPH_MANAGED: "managed", CLAUDE_CODE_SESSION_ID: "claude-parent" }, undefined],
] as const) test(`origin selected from clientInfo and managed parent: ${name} ${JSON.stringify(env)}`, async (t) => {
  const f = fixture(t); const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  const shim = startShim({ path: "memory", input, output, env, connect() {
    const { client } = f.connect(); queueMicrotask(() => client.emit("connect")); return client;
  } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { clientInfo: { name } } }) + "\n");
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delegate", arguments: f.request } }) + "\n");
  await until(() => replies.some((r) => r.id === 1));
  const stored = (f.ledger.readSince(0, 1000).find((fact) => fact.kind === "delegation.created")!.payload as any).request;
  assert.deepEqual(stored.origin, expectedOrigin);
  assert.equal(stored.parentRun, "AGENT_GRAPH_MANAGED" in env ? env.AGENT_GRAPH_MANAGED : undefined);
});

test("reconnection uses exponential intervals capped at five seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new PassThrough(); const output = new PassThrough(); let attempts = 0;
  const shim = startShim({ path: "missing", input, output, connect() {
    attempts++; const [socket] = pair(); queueMicrotask(() => socket.destroy()); return socket;
  } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  for (const delay of [100, 200, 400, 800, 1600, 3200, 5000, 5000]) {
    const before: number = attempts;
    t.mock.timers.tick(delay - 1);
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(attempts, before);
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(attempts, before + 1);
  }
});

test("healthy wait stays open beyond the outage budget and an offline wait returns unavailable", async (t) => {
  const f = fixture(t); const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  f.intake.submit(f.request);
  let available = true; let current: Socket;
  const shim = startShim({ path: "memory", input, output, reconnectInitialMs: 2, unavailableTimeoutMs: 25, connect() {
    const [client, server] = pair(); current = client;
    if (available) { f.protocol.attach(server); queueMicrotask(() => client.emit("connect")); }
    else queueMicrotask(() => client.destroy());
    return client;
  } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: "wait", method: "tools/call", params: {
    name: "wait", arguments: { requestId: "sample" }, _meta: { progressToken: "healthy" },
  } }) + "\n");
  await until(() => replies.some((r) => r.method === "notifications/progress"));
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.ok(!replies.some((r) => r.id === "wait"));
  available = false; current!.destroy();
  await until(() => replies.some((r) => r.id === "wait"));
  assert.equal(replies.find((r) => r.id === "wait").error.code, -32001);
});

test("unconfirmed delegate resend returns a saved result after its initial response is lost", async (t) => {
  const f = fixture(t); const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  let lost = false; let serverToDrop: Socket;
  const requestIds: string[] = [];
  const shim = startShim({ path: "memory", input, output, reconnectInitialMs: 2, connect() {
    const [client, server] = pair();
    const write = server.write.bind(server);
    server.write = ((line: string, ...args: any[]) => {
      const message = JSON.parse(String(line));
      if (!lost && message.result?.structuredContent?.state === "accepted") { lost = true; serverToDrop = server; return true; }
      return write(line, ...args);
    }) as typeof server.write;
    server.on("data", (chunk) => { for (const line of String(chunk).trim().split("\n")) {
      const message = JSON.parse(line); if (message.params?.name === "delegate") requestIds.push(message.params.arguments.requestId);
    } });
    f.protocol.attach(server); queueMicrotask(() => client.emit("connect")); return client;
  } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: "delegate", method: "tools/call", params: { name: "delegate", arguments: f.request } }) + "\n");
  await until(() => f.host.starts.length === 1 && lost);
  f.host.emit(f.host.starts[0].runId, { type: "exit", exitCode: 0 });
  const saved = await f.intake.wait(requestIds[0]); assert.ok(saved.result);
  serverToDrop!.destroy();
  await until(() => replies.some((r) => r.id === "delegate"));
  assert.deepEqual(replies.find((r) => r.id === "delegate").result.structuredContent, saved);
  assert.equal(requestIds.length, 2); assert.equal(new Set(requestIds).size, 1); assert.equal(f.host.starts.length, 1);
});

test("a recovering runner is retried with the same delegation identity", async (t) => {
  const f = fixture(t); const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  let recovering = true; const ids: string[] = [];
  const submit = f.intake.submit.bind(f.intake);
  f.intake.submit = (value) => {
    ids.push((value as { requestId: string }).requestId);
    if (recovering) { recovering = false; throw new Error("Runner is recovering"); }
    return submit(value);
  };
  const shim = startShim({ path: "memory", input, output, reconnectInitialMs: 2, connect() {
    const { client } = f.connect(); queueMicrotask(() => client.emit("connect")); return client;
  } });
  t.after(() => { shim.close(); input.destroy(); output.destroy(); });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delegate", arguments: f.request } }) + "\n");
  await until(() => replies.some((r) => r.id === 1));
  assert.equal(replies.find((r) => r.id === 1).result.structuredContent.state, "accepted");
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 1);
  await until(() => f.host.starts.length === 1); assert.equal(f.host.starts.length, 1);
});
