import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ClaudePluginOptions { outDir: string; shimPath: string; hookPath: string; nodePath: string }

// Claude Code の hook イベントと、agent-graph-hook に渡す引数。
export const HOOK_COMMANDS: readonly [string, string][] = [
  ["SessionStart", "session-start"],
  ["SessionEnd", "session-end"],
  ["UserPromptSubmit", "observe turn_start"],
  ["Stop", "observe turn_done"],
  ["Notification", "observe notification"],
];

export function renderClaudePlugin(options: ClaudePluginOptions): Record<string, string> {
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const hook = (args: string) => ({ hooks: [{ type: "command",
    command: `${JSON.stringify(options.nodePath)} ${JSON.stringify(options.hookPath)} ${args}`, timeout: 5 }] });
  return {
    ".claude-plugin/plugin.json": json({ name: "agent-graph", version: "0.1.0", description: "Register agent-graph delegation" }),
    ".mcp.json": json({ mcpServers: { "agent-graph": {
      command: options.nodePath, args: [options.shimPath], env: { AGENT_GRAPH_CLIENT: "claude" },
    } } }),
    "hooks/hooks.json": json({ hooks: Object.fromEntries(HOOK_COMMANDS.map(([event, args]) => [event, [hook(args)]])) }),
    "recommended-settings.json": json({ permissions: { deny: ["Bash(sudo *)", "Bash(git push *)"] } }),
  };
}

export function generateClaudePlugin(options: ClaudePluginOptions): void {
  for (const [relativePath, contents] of Object.entries(renderClaudePlugin(options))) {
    const path = join(options.outDir, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
}
