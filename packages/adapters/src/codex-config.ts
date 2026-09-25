import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface CodexOptions { shimPath: string; nodePath: string }
export interface CodexInstallOptions extends CodexOptions { configPath: string }

const TOOL_TIMEOUT_SEC = 1800;
const SERVER = "agent-graph";
const TOOL_KEY = "mcp_servers.agent-graph.tools.delegate.approval_mode";

export function renderCodexConfig(options: CodexOptions): string {
  return `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(options.nodePath)}\nargs = [${JSON.stringify(options.shimPath)}]\ntool_timeout_sec = ${TOOL_TIMEOUT_SEC}\n\n[mcp_servers.${SERVER}.env]\nAGENT_GRAPH_CLIENT = "codex"\n\n[mcp_servers.${SERVER}.tools.delegate]\napproval_mode = "approve"\n`;
}

export function renderCodexOverrides(options: CodexOptions): string[] {
  return [
    "-c", `mcp_servers.${SERVER}.command=${JSON.stringify(options.nodePath)}`,
    "-c", `mcp_servers.${SERVER}.args=[${JSON.stringify(options.shimPath)}]`,
    "-c", `mcp_servers.${SERVER}.env.AGENT_GRAPH_CLIENT="codex"`,
    "-c", `mcp_servers.${SERVER}.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
    "-c", `${TOOL_KEY}="approve"`,
  ];
}

export function mergeCodexConfig(existing: string, options: CodexOptions): string {
  const lines = existing.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  const header = /^\s*\[([^\]]+)\]/;
  const isTarget = (name: string): boolean => name === `mcp_servers.${SERVER}` || name.startsWith(`mcp_servers.${SERVER}.`);
  let inside = false;
  let inserted = false;
  const output: string[] = [];
  for (const line of lines) {
    const section = line.match(header);
    if (section) {
      if (inside) inside = false;
      if (isTarget(section[1])) {
        if (!inserted) { output.push(renderCodexConfig(options)); inserted = true; }
        inside = true;
      }
    }
    if (!inside) output.push(line);
  }
  if (!inserted) {
    if (existing && !existing.endsWith("\n")) output.push("\n");
    output.push(renderCodexConfig(options));
  }
  return output.join("");
}

export function installCodexConfig(options: CodexInstallOptions): void {
  const existing = existsSync(options.configPath) ? readFileSync(options.configPath, "utf8") : "";
  const updated = mergeCodexConfig(existing, options);
  if (existsSync(options.configPath)) copyFileSync(options.configPath, `${options.configPath}.agent-graph.bak`);
  writeFileSync(options.configPath, updated);
}
