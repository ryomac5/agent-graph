#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readDashboardPort } from "../../daemon/src/config.ts";

// hook はデーモンに届かなくても黙って 0 で終わる。Claude Code を止めない。
const TIMEOUT_MS = 1000;
// Stop の応答の本文の上限と、要約に使う先頭の行数
export const REPLY_LIMIT = 6000;
export const SUMMARY_LINES = 3;

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  agent_id?: string;
  model?: string;
  prompt?: string;
  last_assistant_message?: string;
  transcript_path?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
}

async function post(path: string, body: unknown): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${readDashboardPort()}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { /* hook は Claude Code の動作を妨げない */ }
}

export function summarize(text: string, lines = SUMMARY_LINES): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join("\n");
}

// Stop の時点で last_assistant_message が無ければ transcript の末尾の assistant 本文を使う。
export function lastAssistantText(transcriptPath: string | undefined): string {
  if (!transcriptPath) return "";
  let contents: string;
  try { contents = readFileSync(transcriptPath, "utf8"); } catch { return ""; }
  const lines = contents.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.endsWith("}")) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
      .map((part) => String((part as { text?: string }).text ?? "")).join("\n").trim();
    if (text) return text;
  }
  return "";
}

// pid は送らない。hook の親は shell のことがあり、根のプロセスとは限らない。pid は shim の hello だけで記録する。
export async function registerSession(input: HookInput): Promise<void> {
  if (!input.session_id || !input.cwd) return;
  await post("/api/sessions", { id: input.session_id, cwd: input.cwd, client: "claude",
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}) });
}

export async function endSession(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  await post(`/api/sessions/${encodeURIComponent(input.session_id)}/end`, {});
}

// 観測の本文を組み立てる。送らないときは undefined。
export function observeBody(kind: string, input: HookInput): Record<string, unknown> | undefined {
  if (!input.session_id || input.agent_id) return undefined;
  const sessionId = input.session_id;
  if (kind === "turn_start") return { kind, sessionId, prompt: typeof input.prompt === "string" ? input.prompt : "" };
  if (kind === "turn_done") {
    if (input.stop_hook_active) return undefined;
    const reply = ((typeof input.last_assistant_message === "string" && input.last_assistant_message.trim())
      || lastAssistantText(input.transcript_path)).trim();
    return { kind, sessionId, summary: summarize(reply), reply: reply.slice(0, REPLY_LIMIT) };
  }
  if (kind === "notification") {
    // ツール実行の許可待ちだけを根の待ちとして記録する
    if (input.notification_type !== "permission_prompt") return undefined;
    return { kind: "waiting", sessionId, reason: "permission" };
  }
  return undefined;
}

export async function observe(kind: string, input: HookInput): Promise<void> {
  const body = observeBody(kind, input);
  if (body) await post("/api/observe", body);
}

export async function runHook(argv: string[], stdin: NodeJS.ReadableStream): Promise<void> {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  let input: HookInput;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== "object") return;
  const [command, kind] = argv;
  if (command === "session-start") await registerSession(input);
  else if (command === "session-end") await endSession(input);
  else if (command === "observe" && kind) await observe(kind, input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { await runHook(process.argv.slice(2), process.stdin); } catch { /* 不正な入力も動作を妨げない */ }
}
