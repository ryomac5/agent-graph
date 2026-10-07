import type { Fact } from "../facts.ts";
import { compareEventOrder } from "../event-order.ts";
import { getMessageText, projectMessages } from "./messages.ts";
import type { MessageProjection } from "./messages.ts";
import { projectNames } from "./names.ts";
import type { ProjectedTask } from "./names.ts";
import { compareText, createNativeId, projectEntities, projectRelations } from "./relations.ts";
import type { ProjectedEntity, ProjectedRelation } from "./relations.ts";

export type ProjectedConversation = ProjectedEntity<"conversation"> & {
  name: string | null;
  name_is_provisional: boolean;
  first_request_excerpt: string | null;
};
export interface ConversationProjection {
  tasks: ProjectedTask[];
  conversations: ProjectedConversation[];
  relations: ProjectedRelation[];
  operation_targets: string[];
}
// SQLite の並びも compareText と同じ UTF-16 の順序に固定する。
export function encodeNameOrder(value: string): string {
  return Buffer.from(value, "utf16le").swap16().toString("hex");
}
// 名前と依頼の抜粋の長さの上限。一覧の 1 行に収まる長さで切る。
export const PROVISIONAL_NAME_LENGTH = 160;
// ホストが利用者の発言の前に差し込む AGENTS.md や skills の本文は、会話の名前にしない。
// 圧縮後の続きの要約も、利用者の依頼ではない。
const DOCUMENT_INJECTION = /^(?:#{1,6}\s*(?:AGENTS|CLAUDE|README)\b|Base directory for this skill:|This session is being continued from a previous conversation)/u;
const TASK_HEADING = /^#{1,6}\s*(?:タスク|Task)\s*[^:：]*[:：]\s*(.+)$/u;
const TITLE_HEADING = /^#\s+(.+)$/u;
const SECTION_HEADING = /^#{1,6}\s/u;
// 依頼を包む札は中身を依頼として読む。それ以外の札はホストの差し込みとして閉じ札まで飛ばす。
const REQUEST_TAGS = new Set(["task", "request", "user_request", "user_query", "prompt"]);
const OPEN_TAG = /^<([A-Za-z_][^<>/]*)>/u;
const REQUEST_LABEL = /^(?:元の依頼|Original request)[:：]\s*$/u;
const REVIEW_PREAMBLE = /^Review a delegated task\.[^\n]*/u;
const REVIEW_TARGET = /^レビュー対象[:：]\s*(.+)$/u;
const PREAMBLE_LINE = /^(?:You are (?:an? |the )|\[Request interrupted by user)/u;
const PREAMBLE_SENTENCE = /^(?:無人実行です。|質問せずに[^。\n]*。|読み取り専用(?:の)?タスクです。|Do not edit files\.)\s*/u;
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/u;
// 句点と感嘆符と疑問符は常に文を区切る。ピリオドは後ろに空白か行末が来るときだけ区切り、パスや版の番号を切らない。
const SENTENCE_END = /[。！？!?]|\.(?=\s|$)/u;

/** 利用者が書いた本文だけを読む。道具の結果や画像の札は依頼に含めない。 */
export function getRequestText(body: Parameters<typeof getMessageText>[0]): string {
  if (Array.isArray(body)) return body.map(getRequestText).filter(Boolean).join("\n");
  if (body && typeof body === "object") {
    const type = typeof body.type === "string" ? body.type : undefined;
    if (type && type !== "text" && type !== "input_text") return "";
  }
  return getMessageText(body);
}
function firstSentence(line: string): string {
  const match = SENTENCE_END.exec(line);
  return (match ? line.slice(0, match.index + match[0].length) : line).trim();
}
function readReviewTarget(text: string): string {
  const lines = text.split("\n");
  const label = lines.findIndex(line => REQUEST_LABEL.test(line.trim()));
  if (label < 0) return extractRequest(text);
  const rest = lines.slice(label + 1).join("\n");
  const first = rest.trim().split("\n")[0];
  try {
    const request = JSON.parse(first) as { title?: unknown; task?: unknown };
    if (typeof request.title === "string" && request.title.trim()) return extractRequest(request.title);
    if (typeof request.task === "string") return extractRequest(request.task);
  } catch { /* 依頼が JSON でなければ本文として読む。 */ }
  return extractRequest(rest);
}
function extractRequest(text: string): string {
  let rest = text;
  for (;;) {
    rest = rest.replace(/^\s+/u, "");
    if (!rest) return "";
    const tag = OPEN_TAG.exec(rest);
    if (tag) {
      const inner = tag[1].trim();
      const name = inner.split(/\s/u)[0];
      const body = rest.slice(tag[0].length);
      const close = [`</${inner}>`, `</${name}>`].map(candidate => [body.indexOf(candidate), candidate.length] as const)
        .find(([position]) => position >= 0);
      if (REQUEST_TAGS.has(name.toLowerCase())) {
        return extractRequest(close ? body.slice(0, close[0]) : body) || (close ? extractRequest(body.slice(close[0] + close[1])) : "");
      }
      // 閉じ札がなければ、発言の残りの全体が差し込みである。
      if (!close) return "";
      rest = body.slice(close[0] + close[1]);
      continue;
    }
    const end = rest.indexOf("\n");
    const line = (end < 0 ? rest : rest.slice(0, end)).trim();
    const next = end < 0 ? "" : rest.slice(end + 1);
    if (DOCUMENT_INJECTION.test(line)) {
      // Codex は AGENTS.md の見出しの後に本文を札で囲む。札がなければ発言の全体が文書である。
      if (next.trimStart().startsWith("<")) { rest = next; continue; }
      return "";
    }
    if (REVIEW_PREAMBLE.test(line)) {
      const target = readReviewTarget(next);
      return target ? `Review of ${target}` : "";
    }
    const reviewed = REVIEW_TARGET.exec(line);
    if (reviewed) {
      const target = extractRequest(reviewed[1].replace(/^(?:タスク|Task)\s*[^:：]*[:：]\s*/u, ""));
      return target ? `Review of ${target}` : "";
    }
    const task = TASK_HEADING.exec(line);
    if (task) return task[1].trim();
    const title = TITLE_HEADING.exec(line);
    if (title) return title[1].trim();
    if (REQUEST_LABEL.test(line) || PREAMBLE_LINE.test(line) || SECTION_HEADING.test(line)) { rest = next; continue; }
    let sentence = line.replace(LIST_MARKER, "");
    while (PREAMBLE_SENTENCE.test(sentence)) sentence = sentence.replace(PREAMBLE_SENTENCE, "");
    if (!sentence) { rest = next; continue; }
    return firstSentence(sentence);
  }
}
/** 会話の名前の規則の唯一の実装。利用者の依頼の最初の文を返し、差し込みだけなら空を返す。 */
export function extractProvisionalName(body: Parameters<typeof getMessageText>[0]): string {
  return extractRequest(getRequestText(body)).slice(0, PROVISIONAL_NAME_LENGTH).trim();
}
/** 利用者の発言だけを名前の候補にする。応答や開発者向けの差し込みは名前にしない。 */
export function extractMessageName(message: { role?: string | null; body?: Parameters<typeof getMessageText>[0] }): string {
  return message.role === "user" ? extractProvisionalName(message.body) : "";
}
/** 会話ごとに、時刻の最も早い利用者の依頼から名前の候補を選ぶ。 */
export function collectProvisionalNames(projection: Pick<MessageProjection, "messages" | "message_memberships">): Map<string, string> {
  const { messages, message_memberships: memberships } = projection;
  const conversationsByMessage = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (!membership.active || !membership.message_id || !membership.conversation_id) continue;
    const ids = conversationsByMessage.get(membership.message_id) ?? new Set<string>();
    ids.add(membership.conversation_id);
    conversationsByMessage.set(membership.message_id, ids);
  }
  const provisionalNames = new Map<string, string>();
  const orderedMessages = [...messages].sort((left, right) => Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || compareEventOrder(left.source_event_id, right.source_event_id) || compareText(left.id, right.id));
  for (const message of orderedMessages) {
    const ids = conversationsByMessage.get(message.id);
    if (!ids || [...ids].every(id => provisionalNames.has(id))) continue;
    const name = extractMessageName(message);
    if (!name) continue;
    for (const id of ids) if (!provisionalNames.has(id)) provisionalNames.set(id, name);
  }
  return provisionalNames;
}
export function projectConversations(
  facts: readonly Fact[], names?: ReadonlyMap<string, string>,
): ConversationProjection {
  const { tasks } = projectNames(facts);
  const rows = projectEntities(facts, "conversation", (payload, id) =>
    payload.provider && payload.native_id ? createNativeId(payload.provider, payload.native_id) : id,
  (fact) => [fact.source.startsWith("host-") ? 1 : 0]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  // 差分反映の索引が渡された場合は、本文を再投影しない。依頼の抜粋は無人実行や名前の確定した会話にも付ける。
  const provisionalNames = names ?? (facts.some(fact => fact.kind.startsWith("message"))
    ? collectProvisionalNames(projectMessages(facts)) : new Map<string, string>());
  const conversations = rows.map((conversation): ProjectedConversation => {
    const task = conversation.task_id ? tasksById.get(conversation.task_id) : undefined;
    const provisionalName = provisionalNames.get(conversation.id) || null;
    const explicitName = (conversation as ProjectedConversation).name;
    // 無人実行は確定した名前を持たず、依頼の抜粋を仮の名前にする。
    const unattended = conversation.type === "unattended";
    const name = unattended ? provisionalName
      : conversation.type === "subagent" ? explicitName ?? task?.name ?? null : task?.name ?? explicitName ?? provisionalName;
    return { ...conversation, name, name_is_provisional: name !== null && (unattended || !explicitName && !task?.name),
      first_request_excerpt: provisionalName };
  });
  const relations = projectRelations(facts);
  return {
    tasks, conversations, relations,
    // 継続元も独立した操作先として残す。関係から操作先を推定しない。
    operation_targets: conversations.map((conversation) => conversation.id),
  };
}
