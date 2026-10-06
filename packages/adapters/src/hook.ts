#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readDashboardPort } from "../../daemon/src/config.ts";

// hook はデーモンに届かなくても黙って 0 で終わる。Claude Code を止めない。
const TIMEOUT_MS = 1000;
// Stop の応答の本文の上限と、要約に使う先頭の行数
export const REPLY_LIMIT = 6000;
export const SUMMARY_LINES = 3;

// サブエージェントの委譲文と報告と再指示の本文の上限
export const TASK_LIMIT = 12_000;
export const REPORT_LIMIT = 8000;
export const MESSAGE_LIMIT = 8000;

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
  model?: string;
  prompt?: string;
  last_assistant_message?: string;
  transcript_path?: string;
  notification_type?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  [key: string]: unknown;
}

// hook を起こした Claude Code の本体の pid。hook の親は shell のことがあるので、祖先をたどって comm が claude のものを探す。
// 見つからなければ undefined。デーモンは本物のセッションに pid を付け、同じ Claude から割れた片割れを寄せる
const realPs = (pid: number): string => execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
// 1 つの hook のプロセスの中では祖先は変わらないので、本物の ps でたどった結果だけを覚える
let cachedClaudePid: number | undefined | null = null;
export function claudePid(ps: (pid: number) => string = realPs): number | undefined {
  if (ps === realPs && cachedClaudePid !== null) return cachedClaudePid;
  let found: number | undefined;
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    let line: string;
    try { line = ps(pid).trim(); } catch { break; }
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) break;
    if (match[2].split("/").at(-1) === "claude") { found = pid; break; }
    pid = Number(match[1]);
  }
  if (ps === realPs) cachedClaudePid = found;
  return found;
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

interface TranscriptEntry { type?: string; message?: { content?: unknown; model?: unknown } }

// transcript の JSONL を読む。無ければ空。壊れた行は飛ばす。
function readTranscript(transcriptPath: string | undefined): TranscriptEntry[] {
  if (!transcriptPath) return [];
  let contents: string;
  try { contents = readFileSync(transcriptPath, "utf8"); } catch { return []; }
  const entries: TranscriptEntry[] = [];
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line.endsWith("}")) continue;
    try { entries.push(JSON.parse(line)); } catch { /* 壊れた行は飛ばす */ }
  }
  return entries;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? "")).join("\n").trim();
}

// Stop の時点で last_assistant_message が無ければ transcript の末尾の assistant 本文を使う。
export function lastAssistantText(transcriptPath: string | undefined): string {
  const entries = readTranscript(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== "assistant") continue;
    const text = textOf(entries[i].message?.content);
    if (text) return text;
  }
  return "";
}

// 子は SubagentHandback の input.message で報告する。その最後の値を返す。無ければ空。
export function handbackMessage(transcriptPath: string | undefined): string {
  let message = "";
  for (const entry of readTranscript(transcriptPath)) {
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message.content as { type?: string; name?: string; input?: { message?: unknown } }[]) {
      if (!block || typeof block !== "object" || block.name !== "SubagentHandback") continue;
      if (typeof block.input?.message === "string" && block.input.message) message = block.input.message;
    }
  }
  return message;
}

// 子の transcript の最初の user 本文。委譲文の控え。
export function firstUserText(transcriptPath: string | undefined): string {
  for (const entry of readTranscript(transcriptPath)) {
    if (entry.type !== "user") continue;
    const text = textOf(entry.message?.content);
    if (text) return text;
  }
  return "";
}

// hook の親は shell のことがあるので、親の pid ではなく祖先の Claude の pid を claudePid として送る。
export async function registerSession(input: HookInput): Promise<void> {
  if (!input.session_id || !input.cwd) return;
  const pid = claudePid();
  await post("/api/sessions", { id: input.session_id, cwd: input.cwd, client: "claude",
    ...(typeof input.model === "string" && input.model ? { model: input.model } : {}), ...(pid ? { claudePid: pid } : {}) });
}

export async function endSession(input: HookInput): Promise<void> {
  if (!input.session_id) return;
  await post(`/api/sessions/${encodeURIComponent(input.session_id)}/end`, {});
}

function str(value: unknown, limit = 200): string | undefined {
  return typeof value === "string" && value ? value.slice(0, limit) : undefined;
}

// PreToolUse。Agent は委譲、SendMessage は再指示、AskUserQuestion は問いの待ち。
function toolStartBody(sessionId: string, input: HookInput): Record<string, unknown> | undefined {
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const toolUseId = str(input.tool_use_id);
  if (input.tool_name === "Agent") {
    return { kind: "subagent_request", sessionId, toolUseId: toolUseId ?? "",
      title: str(toolInput.description) ?? "", task: str(toolInput.prompt, TASK_LIMIT) ?? "",
      ...(str(toolInput.subagent_type) ? { subagentType: str(toolInput.subagent_type) } : {}),
      ...(str(toolInput.name) ? { name: str(toolInput.name) } : {}),
      ...(str(toolInput.model) ? { model: str(toolInput.model) } : {}),
      ...(str(input.agent_id) ? { parentAgentId: str(input.agent_id) } : {}) };
  }
  if (input.tool_name === "SendMessage") {
    const to = str(toolInput.to);
    if (!to) return undefined;
    return { kind: "subagent_message", sessionId, toolUseId: toolUseId ?? "", to,
      text: str(toolInput.message, MESSAGE_LIMIT) ?? str(toolInput.summary, MESSAGE_LIMIT) ?? "" };
  }
  if (input.tool_name === "AskUserQuestion") return { kind: "waiting", sessionId, reason: "question" };
  return undefined;
}

// SubagentStop。報告は SubagentHandback の message を優先し、無ければ最終応答。
// 最後の応答に使われたモデル。transcript の assistant の行に message.model として残る。合成の応答は飛ばす
export function lastAssistantModel(transcriptPath: string | undefined): string {
  const entries = readTranscript(transcriptPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const model = entries[i].type === "assistant" ? entries[i].message?.model : undefined;
    if (typeof model === "string" && model && !model.startsWith("<")) return model;
  }
  return "";
}

function subagentStopBody(sessionId: string, input: HookInput): Record<string, unknown> {
  const transcript = input.agent_transcript_path;
  const report = (handbackMessage(transcript) || (typeof input.last_assistant_message === "string" && input.last_assistant_message.trim())
    || lastAssistantText(transcript)).trim();
  const task = firstUserText(transcript);
  // 子が実際に使ったモデル。呼び出しのときは別名か根のモデルしか分からない
  const model = lastAssistantModel(transcript);
  return { kind: "subagent_stop", sessionId, ...(str(input.agent_id) ? { agentId: str(input.agent_id) } : {}),
    agentType: str(input.agent_type) ?? "", summary: summarize(report), report: report.slice(0, REPORT_LIMIT),
    ...(task ? { task: task.slice(0, TASK_LIMIT) } : {}), ...(model ? { model } : {}) };
}

// tool_response から子の agent_id を拾う。構造化なら agentId か agent_id、文字列なら "agentId: <id>" の行。
export function agentIdOf(response: unknown): string | undefined {
  if (response && typeof response === "object") {
    const record = response as { agentId?: unknown; agent_id?: unknown; content?: unknown };
    const direct = str(record.agentId) ?? str(record.agent_id);
    if (direct) return direct;
    if (typeof record.content === "string") return agentIdOf(record.content);
    if (!Array.isArray(record.content)) return undefined;
    return agentIdOf(record.content.map((part) => part && typeof part === "object" ? String((part as { text?: string }).text ?? "") : "").join("\n"));
  }
  if (typeof response !== "string") return undefined;
  const found = response.match(/agent[_ ]?id\s*[:=]\s*["']?([A-Za-z0-9_@.:-]+)/i);
  return found ? found[1] : undefined;
}

// PostToolUse と PostToolUseFailure。AskUserQuestion は待ちの解除、Agent は起動の結果。
function toolDoneBody(sessionId: string, input: HookInput): Record<string, unknown> | undefined {
  const failed = input.hook_event_name === "PostToolUseFailure";
  if (input.tool_name === "AskUserQuestion") return failed ? undefined : { kind: "resumed", sessionId };
  if (input.tool_name !== "Agent") return undefined;
  const agentId = agentIdOf(input.tool_response);
  return { kind: "subagent_done", sessionId, toolUseId: str(input.tool_use_id) ?? "", failed,
    ...(agentId ? { agentId } : {}) };
}

// 観測の本文を組み立てる。送らないときは undefined。
export function observeBody(kind: string, input: HookInput): Record<string, unknown> | undefined {
  if (!input.session_id) return undefined;
  const sessionId = input.session_id;
  if (kind === "tool_start") return toolStartBody(sessionId, input);
  if (kind === "tool_done") return toolDoneBody(sessionId, input);
  if (kind === "subagent_start") {
    const agentId = str(input.agent_id);
    if (!agentId) return undefined;
    return { kind, sessionId, agentId, agentType: str(input.agent_type) ?? "",
      ...(str(input.tool_use_id) ? { toolUseId: str(input.tool_use_id) } : {}) };
  }
  if (kind === "subagent_stop") return subagentStopBody(sessionId, input);
  // turn と通知は根のものだけを記録する。サブエージェントの中で発火した hook は agent_id を持つ
  if (input.agent_id) return undefined;
  // 無人実行の子の指示は人の指示ではない。daemon はこの印を見て番号を付けない
  if (kind === "turn_start") return { kind, sessionId, prompt: typeof input.prompt === "string" ? input.prompt : "",
    ...(process.env.AGENT_GRAPH_HEADLESS === "1" ? { headless: true } : {}) };
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
  const pid = body ? claudePid() : undefined;
  if (body) await post("/api/observe", pid ? { ...body, claudePid: pid } : body);
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
