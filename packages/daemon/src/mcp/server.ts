import type { Duplex } from "node:stream";
import { JsonRpcLines, type JsonRpcMessage } from "./jsonrpc.ts";

export type DelegateRequest = {
  role: "orchestrate" | "implement" | "research" | "document" | "review";
  title: string;
  task: string;
  accept: string[];
  scope?: string[];
  outputs?: string[];
  cwd?: string;
  constraints?: {
    excludeFamily?: ("anthropic" | "openai")[];
    excludeModels?: string[];
    minTier?: "high" | "mid" | "low";
  };
  timeoutSec?: number;
  review?: boolean;
};

export type DelegateHandler<Context, Result = unknown> = (request: DelegateRequest, context: Context) => Promise<Result>;

const inputSchema = {
  type: "object",
  properties: {
    role: { type: "string", enum: ["orchestrate", "implement", "research", "document", "review"] },
    title: { type: "string", maxLength: 40 },
    task: { type: "string" },
    accept: { type: "array", items: { type: "string" }, minItems: 1 },
    scope: { type: "array", items: { type: "string" } },
    outputs: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    constraints: {
      type: "object",
      properties: {
        excludeFamily: { type: "array", items: { type: "string", enum: ["anthropic", "openai"] } },
        excludeModels: { type: "array", items: { type: "string" } },
        minTier: { type: "string", enum: ["high", "mid", "low"] },
      },
    },
    timeoutSec: { type: "number" },
    review: { type: "boolean" },
  },
  required: ["role", "title", "task", "accept"],
} as const;

export function createMcpSession<Context>(handler: DelegateHandler<Context>, context: Context): (stream: Duplex) => JsonRpcLines;
export function createMcpSession<Context>(stream: Duplex, handler: DelegateHandler<Context>, context: Context): JsonRpcLines;
export function createMcpSession<Context>(
  streamOrHandler: Duplex | DelegateHandler<Context>,
  handlerOrContext: DelegateHandler<Context> | Context,
  context?: Context,
): JsonRpcLines | ((stream: Duplex) => JsonRpcLines) {
  if (typeof streamOrHandler === "function") {
    const handler = streamOrHandler;
    const sessionContext = handlerOrContext as Context;
    return (stream: Duplex) => createMcpSession(stream, handler, sessionContext);
  }
  const stream = streamOrHandler;
  const handler = handlerOrContext as DelegateHandler<Context>;

  const lines = new JsonRpcLines(stream, (message) => { void handleMessage(message); });
  stream.on("data", (chunk: Buffer) => lines.receive(chunk));

  async function handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.jsonrpc !== "2.0") {
      lines.error(message.id ?? null, -32600, "Invalid Request");
      return;
    }
    if (message.method === "notifications/initialized") return;
    if (message.id === undefined) return;
    if (message.method === "initialize") {
      const params = message.params as { protocolVersion?: string } | undefined;
      lines.response(message.id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-graph", version: "0.1.0" },
      });
    } else if (message.method === "ping") {
      lines.response(message.id, {});
    } else if (message.method === "tools/list") {
      lines.response(message.id, { tools: [{ name: "delegate", description: "Delegate a task to an agent", inputSchema }] });
    } else if (message.method === "tools/call") {
      const params = message.params as { name?: string; arguments?: DelegateRequest } | undefined;
      if (params?.name !== "delegate" || !params.arguments) {
        lines.error(message.id, -32602, "Invalid params");
        return;
      }
      try {
        const result = await handler(params.arguments, context as Context);
        lines.response(message.id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        lines.response(message.id, { content: [{ type: "text", text: String(error) }], isError: true });
      }
    } else {
      lines.error(message.id, -32601, "Method not found");
    }
  }
  return lines;
}
