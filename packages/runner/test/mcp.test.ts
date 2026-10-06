import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, messages, until } from "./samples/S13/fixture.ts";

function send(socket: ReturnType<ReturnType<typeof fixture>["connect"]>["client"], value: unknown) {
  socket.write(JSON.stringify(value) + "\n");
}

test("MCP initializes, lists exactly three tools and delegates before launching", async (t) => {
  const f = fixture(t); const { client } = f.connect(); const replies = messages(client);
  send(client, { type: "hello", role: "mcp", version: 1 });
  send(client, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "codex" } } });
  send(client, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(client, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  send(client, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate", arguments: f.request } });
  let startsAtAcceptance: number | undefined;
  client.on("data", () => { if (replies.some((r) => r.id === 2)) startsAtAcceptance ??= f.host.starts.length; });
  await until(() => replies.some((r) => r.id === 2));
  assert.equal(replies.find((r) => r.id === 0).result.protocolVersion, "2024-11-05");
  assert.deepEqual(replies.find((r) => r.id === 1).result.tools.map((tool: { name: string }) => tool.name), ["delegate", "status", "wait"]);
  assert.equal(replies.find((r) => r.id === 2).result.structuredContent.state, "accepted");
  assert.equal(startsAtAcceptance, 0);
  await until(() => f.host.starts.length === 1);
  send(client, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delegate", arguments: f.request } });
  send(client, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status", arguments: { requestId: "sample" } } });
  await until(() => replies.some((r) => r.id === 4));
  assert.equal(replies.find((r) => r.id === 3).result.structuredContent.state, "running");
  assert.equal(replies.find((r) => r.id === 4).result.structuredContent.state, "running");
  assert.equal(f.host.starts.length, 1);
});

test("wait emits ledger state progress and returns the saved terminal result", async (t) => {
  const f = fixture(t); f.intake.submit(f.request);
  const { client } = f.connect(); const replies = messages(client);
  send(client, { type: "hello", role: "mcp", version: 1 });
  send(client, { jsonrpc: "2.0", id: "wait", method: "tools/call", params: { name: "wait", arguments: { requestId: "sample" }, _meta: { progressToken: 0 } } });
  await until(() => f.host.starts.length === 1 && replies.some((r) => r.method === "notifications/progress"));
  assert.ok(!replies.some((r) => r.id === "wait"));
  f.host.emit(f.host.starts[0].runId, { type: "exit", exitCode: 1 });
  await until(() => replies.some((r) => r.id === "wait"));
  const progress = replies.filter((r) => r.method === "notifications/progress");
  assert.ok(progress.length >= 2);
  assert.ok(progress.every((r) => r.params.progressToken === 0));
  assert.equal(JSON.parse(progress.at(-1).params.message).state, "failed");
  assert.deepEqual(replies.find((r) => r.id === "wait").result.structuredContent, f.intake.status("sample"));
  assert.deepEqual(f.intake.submit(f.request), f.intake.status("sample"));
});

test("malformed input, conflicts and missing requests return errors without extra starts", async (t) => {
  const f = fixture(t); const { client } = f.connect(); const replies = messages(client);
  send(client, { type: "hello", role: "mcp", version: 1 }); client.write("{invalid}\n");
  send(client, { jsonrpc: "2.0", id: 1, method: "unknown" });
  send(client, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "delegate", arguments: f.request } });
  send(client, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delegate", arguments: { ...f.request, task: "different" } } });
  send(client, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wait", arguments: { requestId: "missing" } } });
  await until(() => replies.some((r) => r.id === 4));
  assert.equal(replies.find((r) => r.id === null).error.code, -32700);
  assert.equal(replies.find((r) => r.id === 1).error.code, -32601);
  assert.match(replies.find((r) => r.id === 3).error.message, /Conflicting/);
  assert.match(replies.find((r) => r.id === 4).error.message, /Unknown/);
});

test("the same listener routes cli/api hello to the existing runner protocol", async (t) => {
  const f = fixture(t); const { client } = f.connect(); const replies = messages(client);
  send(client, { type: "hello", role: "api", version: 1 });
  send(client, { type: "req", cmd_id: "list", command: "intake.list" });
  await until(() => replies.some((r) => r.cmd_id === "list"));
  assert.deepEqual(replies.find((r) => r.cmd_id === "list").result, []);
});

test("cancelled and disconnected wait calls stop emitting progress", async (t) => {
  const f = fixture(t); f.intake.submit(f.request);
  const { client } = f.connect(); const replies = messages(client);
  send(client, { type: "hello", role: "mcp", version: 1 });
  send(client, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wait", arguments: { requestId: "sample" }, _meta: { progressToken: "cancel" } } });
  await until(() => replies.some((r) => r.method === "notifications/progress"));
  send(client, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const count = replies.length;
  await until(() => f.host.starts.length === 1);
  f.host.emit(f.host.starts[0].runId, { type: "exit", exitCode: 1 });
  await f.intake.wait("sample");
  assert.equal(replies.length, count);
});
