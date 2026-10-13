import type { JsonValue } from "../facts.ts";
import type { ClaudeMessageFlags } from "../claude-message-flags.ts";

const INJECTED_TAGS = "system-reminder|task-notification|local-command-caveat|local-command-stdout|local-command-stderr|command-message|user-prompt-submit-hook";
const WRAPPER = new RegExp(`^[ \\t]*<(pasted_content|${INJECTED_TAGS})(?: id="([^"\\n]+)")?>([\\s\\S]*?)<\\/\\1(?: id="\\2")?>`, "gm");
const REPORT_PREFIX = /^\s*Another Claude session sent a message:\s*/u;
type NormalizedClaudeContent = { body?: JsonValue; role?: string; content_normalized?: true; relayed_instruction?: true };

/** 行頭の対になった包みだけを読む。コード例の札はそのまま残す。 */
function unwrapText(text: string): string {
  const fences: [number, number][] = [];
  let start: number | undefined;
  let delimiter = "";
  for (const match of text.matchAll(/^[ \t]*(`{3,}|~{3,})[^\n]*/gm)) {
    if (start === undefined) { start = match.index; delimiter = match[1]; }
    else if (match[1][0] === delimiter[0] && match[1].length >= delimiter.length) {
      fences.push([start, match.index + match[0].length]); start = undefined;
    }
  }
  if (start !== undefined) fences.push([start, text.length]);
  let changed = false;
  const result = text.replace(WRAPPER, (whole: string, tag: string, _id: string, body: string, offset: number) => {
    if (fences.some(([from, to]) => offset >= from && offset < to)) return whole;
    changed = true;
    return tag === "pasted_content" ? body.replace(/^\s*\n|\n\s*$/g, "") : "";
  });
  return changed ? result.trim() : text;
}

function mapText(body: JsonValue | undefined, transform: (text: string) => string): JsonValue | undefined {
  if (typeof body === "string") return transform(body);
  if (Array.isArray(body)) return body.map(block => mapText(block, transform) ?? null);
  if (body && typeof body === "object" && (!body.type || body.type === "text" || body.type === "input_text")) {
    if (typeof body.text === "string") return { ...body, text: transform(body.text) };
    if (typeof body.content === "string") return { ...body, content: transform(body.content) };
  }
  return body;
}

/** 台帳は原文を保ち、発言・依頼の抜粋・検索には同じ本文を渡す。 */
export function normalizeClaudeContent(message: { provider?: string; role?: string; body?: JsonValue; transcript_flags?: ClaudeMessageFlags }): NormalizedClaudeContent {
  if (message.provider !== "claude" || !["user", "agent_report"].includes(message.role ?? "")) return {};
  let role = message.role!;
  let relayedInstruction = false;
  let hasUserText = Array.isArray(message.body) && message.body.some(block => block && typeof block === "object"
    && !Array.isArray(block) && block.type && block.type !== "text" && block.type !== "input_text");
  const body = mapText(message.body, text => {
    if (message.role === "agent_report" || REPORT_PREFIX.test(text)) {
      role = "agent_report";
      const rest = text.replace(REPORT_PREFIX, "");
      const report = /^<agent-message\b[^>]*>([\s\S]*?)<\/agent-message>/u.exec(rest)?.[1]
        ?? rest.split(/\n\s*That "other Claude session"/u)[0];
      return report.replace(/^\s*\[Subagent hand-back\][\s\S]*?The report follows:\s*/u, "")
        .replace(/^ {2}/gm, "").trim();
    }
    if (/^\s*\[SYSTEM NOTIFICATION[^\n]*\]/u.test(text)) {
      role = "notification";
      return message.transcript_flags?.isMeta ? text : "";
    }
    if (message.transcript_flags?.isMeta && /^The (?:user sent a new|coordinator sent a) message while you were working:\n/u.test(text)) {
      relayedInstruction = true;
    }
    const cleaned = unwrapText(text);
    if (cleaned.trim()) hasUserText = true;
    else if (cleaned !== text && role === "user") role = "notification";
    return cleaned;
  });
  if (role === "notification" && hasUserText) role = "user";
  return { body, role, content_normalized: true as const,
    ...(relayedInstruction ? { relayed_instruction: true as const } : {}) };
}
