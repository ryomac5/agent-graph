import type { Fact, JsonValue } from "../facts.ts";
import { compareFacts, compareText, createNativeId, projectConversationIds, projectEntities, serializeValue } from "./relations.ts";
import type { ProjectedEntity } from "./relations.ts";

// 出所と確度は、本文を決めた事実から取る。本文がなければ最初の事実から取る。
export type ProjectedMessage = ProjectedEntity<"message"> & {
  source_ts: string; source_event_id: string; source: string; confidence: string;
};
export type ProjectedMembership = ProjectedEntity<"message_membership">;
export interface MessageProjection {
  messages: ProjectedMessage[];
  message_memberships: ProjectedMembership[];
  discrepancies: { message_id: string; fact_ids: string[] }[];
}
export function getMessageText(body: JsonValue | undefined): string {
  if (typeof body === "string") return body;
  if (Array.isArray(body)) return body.map(getMessageText).filter(Boolean).join("\n");
  if (body && typeof body === "object") return getMessageText(body.text ?? body.content);
  return "";
}
export function projectMessages(facts: readonly Fact[]): MessageProjection {
  const uniqueFacts = [...new Map(facts.map((fact) => [fact.fact_id, fact])).values()];
  const identify = (payload: { provider?: string; native_id?: string }, id: string) =>
    payload.provider && payload.native_id ? createNativeId(payload.provider, payload.native_id) : id;
  // 内容の版を先に比較し、同じ版ではホストを履歴より優先する。
  const prioritize = (fact: Fact, payload: { version?: number }) => {
    return [payload.version ?? 0,
      fact.source === "ui" ? 2 : fact.source.startsWith("host-") ? 1 : 0];
  };
  const messages = projectEntities(facts, "message", identify, prioritize);
  const messageIds = new Map(projectEntities(facts, "message", undefined, prioritize)
    .map((message) => [message.id, identify(message, message.id)]));
  const conversationIds = facts.some(fact => fact.kind.startsWith("message_membership."))
    ? projectConversationIds(facts) : new Map<string, string>();
  const firstFacts = new Map<string, Fact>();
  const bodyFacts = new Map<string, Fact[]>();
  const superseded = new Set(uniqueFacts.filter((fact) => fact.supersedes).map((fact) => fact.supersedes));
  for (const fact of uniqueFacts.sort(compareFacts)) {
    if (fact.kind.startsWith("message.")) {
      const payload = fact.payload as { provider?: string; native_id?: string; body?: JsonValue } | null;
      const subjectId = fact.subject.slice("message:".length);
      const id = messageIds.get(subjectId) ?? subjectId;
      if (!firstFacts.has(id)) firstFacts.set(id, fact);
      if (payload?.body !== undefined && !superseded.has(fact.fact_id)) {
        const observations = bodyFacts.get(id) ?? [];
        observations.push(fact);
        bodyFacts.set(id, observations);
      }
    }
  }
  const memberships = projectEntities(facts, "message_membership", (payload, id) => {
    if (!payload.message_id || !payload.conversation_id) return id;
    return JSON.stringify([messageIds.get(payload.message_id) ?? payload.message_id,
      conversationIds.get(payload.conversation_id) ?? payload.conversation_id]);
  }).map((membership) => ({
    ...membership,
    message_id: membership.message_id && (messageIds.get(membership.message_id) ?? membership.message_id),
    conversation_id: membership.conversation_id && (conversationIds.get(membership.conversation_id) ?? membership.conversation_id),
  }));
  const discrepancies = messages.flatMap((message) => {
    const observations = bodyFacts.get(message.id) ?? [];
    const host = observations.filter((fact) => fact.source.startsWith("host-"));
    const differing = host.length && message.body !== undefined ? observations.filter((fact) => {
      const payload = fact.payload as { body: JsonValue; version?: number };
      return !fact.source.startsWith("host-") && fact.source !== "ui"
        && payload.version === message.version && serializeValue(payload.body) !== serializeValue(message.body!);
    }) : [];
    return differing.length ? [{ message_id: message.id, fact_ids: differing.map((fact) => fact.fact_id).sort(compareText) }] : [];
  });
  const rank = (fact: Fact) => prioritize(fact, (fact.payload ?? {}) as { version?: number });
  function selectOrigin(id: string): Fact {
    let selected: Fact | undefined;
    for (const fact of bodyFacts.get(id) ?? []) {
      if (!selected) { selected = fact; continue; }
      const [left, right] = [rank(fact), rank(selected)];
      const difference = left[0] - right[0] || left[1] - right[1] || compareFacts(fact, selected);
      if (difference > 0) selected = fact;
    }
    return selected ?? firstFacts.get(id)!;
  }
  return {
    messages: messages.map((message) => {
      const origin = selectOrigin(message.id);
      return { ...message,
        source_ts: firstFacts.get(message.id)!.source_ts,
        source_event_id: firstFacts.get(message.id)!.source_event_id,
        source: origin.source, confidence: origin.confidence,
      };
    }),
    message_memberships: memberships,
    discrepancies,
  };
}
