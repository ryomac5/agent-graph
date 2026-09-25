#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PORT = 7420;

function readPort(): number {
  if (process.env.AGENT_GRAPH_PORT !== undefined) return Number(process.env.AGENT_GRAPH_PORT);
  const path = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agent-graph", "config.toml");
  let contents = "";
  try { contents = readFileSync(path, "utf8"); } catch { return DEFAULT_PORT; }
  let dashboard = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]/);
    if (section) { dashboard = section[1] === "dashboard"; continue; }
    if (dashboard) {
      const port = line.match(/^\s*port\s*=\s*(\d+)/);
      if (port) return Number(port[1]);
    }
  }
  return DEFAULT_PORT;
}

export async function registerSession(input: { session_id?: string; cwd?: string }): Promise<void> {
  if (!input.session_id || !input.cwd) return;
  try {
    await fetch(`http://127.0.0.1:${readPort()}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: input.session_id, cwd: input.cwd, client: "claude" }),
      signal: AbortSignal.timeout(1000),
    });
  } catch { /* hook は Claude Code の起動を妨げない */ }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv[2] === "session-start") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    try { await registerSession(JSON.parse(input)); } catch { /* 不正な入力も起動を妨げない */ }
  }
}
