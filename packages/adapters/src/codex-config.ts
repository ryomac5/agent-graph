import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export interface CodexOptions { shimPath: string; nodePath: string }
export interface CodexInstallOptions extends CodexOptions { configPath: string }

const TOOL_TIMEOUT_SEC = 1800;
const SERVER = "agent-graph";
const TOOL_KEY = "mcp_servers.agent-graph.tools.delegate.approval_mode";
// 値を生成時に固定せず、各セッションの接続先とトレース文脈を shim に渡す。
const SHIM_ENV_VARS = ["AGENT_GRAPH_SOCKET", "XDG_STATE_HOME", "TRACEPARENT", "TRACESTATE", "AGENT_GRAPH_SESSION"];

export function renderCodexConfig(options: CodexOptions): string {
  return `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(options.nodePath)}\nargs = [${JSON.stringify(options.shimPath)}]\nenv_vars = ${JSON.stringify(SHIM_ENV_VARS)}\ntool_timeout_sec = ${TOOL_TIMEOUT_SEC}\n\n[mcp_servers.${SERVER}.env]\nAGENT_GRAPH_CLIENT = "codex"\n\n[mcp_servers.${SERVER}.tools.delegate]\napproval_mode = "approve"\n`;
}

export function renderCodexOverrides(options: CodexOptions): string[] {
  return [
    "-c", `mcp_servers.${SERVER}={command=${JSON.stringify(options.nodePath)},args=[${JSON.stringify(options.shimPath)}],env={AGENT_GRAPH_CLIENT="codex"},env_vars=${JSON.stringify(SHIM_ENV_VARS)},tool_timeout_sec=${TOOL_TIMEOUT_SEC},required=true}`,
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

export function removeCodexConfig(existing: string): string {
  const lines = existing.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? [];
  let inside = false;
  return lines.filter((line) => {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) inside = section[1] === `mcp_servers.${SERVER}` || section[1].startsWith(`mcp_servers.${SERVER}.`);
    return !inside;
  }).join("");
}

export function uninstallCodexConfig(options: { configPath: string }): void {
  if (!existsSync(options.configPath)) return;
  const existing = readFileSync(options.configPath, "utf8");
  const updated = removeCodexConfig(existing);
  if (updated === existing) return;
  copyFileSync(options.configPath, `${options.configPath}.agent-graph.bak`);
  writeFileSync(options.configPath, updated);
}
