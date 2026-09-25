import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DelegateRequest, DelegateResult } from "../../core/src/delegate/types.ts";

type Options = { shimPath?: string; nodePath?: string; env: NodeJS.ProcessEnv; cwd: string };
type Response = { id?: number; result?: unknown; error?: { message: string } };

export async function connectDelegate(options: Options): Promise<{
  delegate(request: DelegateRequest): Promise<DelegateResult>;
  close(): void;
}> {
  const shimPath = options.shimPath ?? fileURLToPath(new URL("../../daemon/src/shim.ts", import.meta.url));
  const child: ChildProcessWithoutNullStreams = spawn(options.nodePath ?? process.execPath, [shimPath], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, AGENT_GRAPH_CLIENT: "planner" },
    stdio: "pipe",
  });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let buffer = "";
  let failure: Error | undefined;
  const fail = (error: Error): void => {
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\n");
    while (end !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) {
        try {
          const response = JSON.parse(line) as Response;
          if (response.id !== undefined) {
            const entry = pending.get(response.id);
            if (entry) {
              pending.delete(response.id);
              if (response.error) entry.reject(new Error(response.error.message));
              else entry.resolve(response.result);
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
      end = buffer.indexOf("\n");
    }
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`MCP shim exited: ${code ?? signal}`)));
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  };
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "agent-graph-planner", version: "0.1.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    async delegate(delegateRequest) {
      const result = await request("tools/call", { name: "delegate", arguments: delegateRequest }) as {
        structuredContent?: DelegateResult;
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
      if (result.isError) throw new Error(result.content?.find((item) => item.type === "text")?.text ?? "delegate failed");
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = result.content?.find((item) => item.type === "text")?.text;
      if (!text) throw new Error("delegate returned no result");
      return JSON.parse(text) as DelegateResult;
    },
    close() { child.kill(); },
  };
}
