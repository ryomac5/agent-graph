import type { Fact } from "../facts.ts";
import { getMessageText, projectMessages } from "./messages.ts";
import { projectNames } from "./names.ts";
import type { ProjectedTask } from "./names.ts";
import { compareText, createNativeId, projectEntities, projectRelations } from "./relations.ts";
import type { ProjectedEntity, ProjectedRelation } from "./relations.ts";

export type ProjectedConversation = ProjectedEntity<"conversation"> & {
  name: string | null;
  name_is_provisional: boolean;
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
export function extractProvisionalName(body: Parameters<typeof getMessageText>[0]): string {
  return getMessageText(body).trim().split(/(?<=[。.!?？！])|\n/u)[0];
}
function projectProvisionalNames(facts: readonly Fact[]): Map<string, string> {
  const { messages, message_memberships: memberships } = projectMessages(facts);
  const conversationsByMessage = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (!membership.active || !membership.message_id || !membership.conversation_id) continue;
    const ids = conversationsByMessage.get(membership.message_id) ?? new Set<string>();
    ids.add(membership.conversation_id);
    conversationsByMessage.set(membership.message_id, ids);
  }
  const provisionalNames = new Map<string, string>();
  const orderedMessages = [...messages].sort((left, right) => Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || compareText(left.source_event_id, right.source_event_id) || compareText(left.id, right.id));
  for (const message of orderedMessages) {
    const text = getMessageText(message.body);
    if (!text.trim()) continue;
    const name = extractProvisionalName(message.body);
    for (const id of conversationsByMessage.get(message.id) ?? []) {
      if (!provisionalNames.has(id)) provisionalNames.set(id, name);
    }
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
  // 差分反映の索引が渡された場合や名前が確定済みの場合は、本文を再投影しない。
  const needsProvisionalNames = names === undefined && facts.some(fact => fact.kind.startsWith("message."))
    && rows.some(conversation => conversation.type !== "unattended"
    && conversation.type !== "subagent" && !(conversation as ProjectedConversation).name
    && !tasksById.get(conversation.task_id ?? "")?.name);
  const provisionalNames = names ?? (needsProvisionalNames ? projectProvisionalNames(facts) : new Map<string, string>());
  const conversations = rows.map((conversation): ProjectedConversation => {
    const task = conversation.task_id ? tasksById.get(conversation.task_id) : undefined;
    const provisionalName = provisionalNames.get(conversation.id) || null;
    const explicitName = (conversation as ProjectedConversation).name;
    const name = conversation.type === "unattended" ? null
      : conversation.type === "subagent" ? explicitName ?? task?.name ?? null : task?.name ?? explicitName ?? provisionalName;
    return { ...conversation, name, name_is_provisional: name !== null && !explicitName && !task?.name };
  });
  const relations = projectRelations(facts);
  return {
    tasks, conversations, relations,
    // 継続元も独立した操作先として残す。関係から操作先を推定しない。
    operation_targets: conversations.map((conversation) => conversation.id),
  };
}
