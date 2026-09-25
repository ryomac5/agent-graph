import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcLines } from "../src/mcp/jsonrpc.ts";
import { createMcpSession } from "../src/mcp/server.ts";

test("JSON-RPC handles split and multiple lines", () => {
  const output = new PassThrough();
  const received: unknown[] = [];
  const lines = new JsonRpcLines(output, (message) => received.push(message));
  lines.receive('{"jsonrpc":"2.0","id":1,"method":"pi');
  assert.equal(received.length, 0);
  lines.receive('ng"}\n{"jsonrpc":"2.0","method":"notice"}\n');
  assert.equal(received.length, 2);
  lines.request(2, "ping");
  lines.response(2, {});
  lines.notification("notice");
  lines.error(2, -32601, "missing");
  const written = output.read().toString().trim().split("\n").map((line: string) => JSON.parse(line));
  assert.equal(written.length, 4);
});

test("MCP initialize, list and call", async () => {
  const responses: Record<number, unknown> = {};
  const context = { cwd: "/tmp/project" };
  const handler = async (request: { title: string }, receivedContext: typeof context) => ({ title: request.title, cwd: receivedContext.cwd });
  const reader = new JsonRpcLines(new PassThrough(), (message) => {
    if (message.result && typeof message.id === "number") responses[message.id] = message.result;
  });
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { reader.receive(chunk); callback(); },
  });
  createMcpSession(stream, handler, context);
  stream.push('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n');
  stream.push('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  stream.push('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"delegate","arguments":{"role":"implement","title":"Task","task":"Do","accept":["true"]}}}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((responses[1] as { protocolVersion: string }).protocolVersion, "2024-11-05");
  const tools = (responses[2] as { tools: { inputSchema: { required: string[] } }[] }).tools;
  assert.deepEqual(tools[0].inputSchema.required, ["role", "title", "task", "accept"]);
  const result = responses[3] as { content: { text: string }[]; structuredContent: unknown };
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.deepEqual(result.structuredContent, { title: "Task", cwd: "/tmp/project" });
});
