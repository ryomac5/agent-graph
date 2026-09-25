import { fileURLToPath } from "node:url";

const client = process.argv[2];
if (client !== "claude" && client !== "codex") throw new Error("Expected claude or codex");
const env = Object.fromEntries(["AGENT_GRAPH_SOCKET", "TRACEPARENT", "TRACESTATE", "AGENT_GRAPH_SESSION"]
  .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
env.AGENT_GRAPH_CLIENT = client;
const shim = fileURLToPath(new URL("../packages/daemon/src/shim.ts", import.meta.url));
if (client === "claude") {
  console.log(JSON.stringify({ mcpServers: { "agent-graph": { command: process.execPath, args: [shim], env } } }));
} else {
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",");
  console.log(`mcp_servers.agent-graph={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(shim)}],env={${pairs}},tool_timeout_sec=1800}`);
}
