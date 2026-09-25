#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readDashboardPort } from "../../daemon/src/config.ts";

export async function registerSession(input: { session_id?: string; cwd?: string }): Promise<void> {
  if (!input.session_id || !input.cwd) return;
  try {
    await fetch(`http://127.0.0.1:${readDashboardPort()}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: input.session_id, cwd: input.cwd, client: "claude" }),
      signal: AbortSignal.timeout(1000),
    });
  } catch { /* hook は Claude Code の起動を妨げない */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === "session-start") {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    try { await registerSession(JSON.parse(input)); } catch { /* 不正な入力も起動を妨げない */ }
  }
}
