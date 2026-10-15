import type { Fact, JsonValue } from "../facts.ts";
import { getMessageText } from "./messages.ts";
import { compareText, projectConversationIds } from "./relations.ts";
import { normalizeClaudeContent } from "./claude-content.ts";
import { projectRunHistory } from "./runs.ts";
import { normalizeStoredTimestamp } from "../timestamps.ts";

export interface PendingInput {
  id: string;
  body: JsonValue;
  source_ts: string;
  delivery_id?: string;
  state: "queued";
}

/** queue-operation と実行の境界だけで、メモリ上の待ち行列を再現する。 */
export function projectInputQueues(facts: readonly Fact[]): Map<string, PendingInput[]> {
  const queues = new Map<string, PendingInput[]>();
  const events = [...new Map(facts.filter(fact => fact.kind === "conversation.input_queue_changed")
    .map(fact => [fact.fact_id, fact])).values()].sort((a, b) => compareText(a.source_event_id, b.source_event_id));
  if (!events.length) return queues;
  const ids = projectConversationIds(facts);
  const { runs, ends } = projectRunHistory(facts);
  const boundaries = new Map<string, number>();
  const recordBoundary = (conversationId: string, timestamp: string) => {
    const id = ids.get(conversationId) ?? conversationId;
    boundaries.set(id, Math.max(boundaries.get(id) ?? -Infinity, Date.parse(timestamp)));
  };
  for (const fact of facts) {
    if (fact.kind === "run.created" && fact.payload?.conversation_id) {
      recordBoundary(fact.payload.conversation_id, fact.payload.started_ts ?? fact.source_ts);
    }
  }
  for (const run of runs) {
    if (run.started_ts) recordBoundary(run.conversation_id, run.started_ts);
    if (run.ended_ts) recordBoundary(run.conversation_id, run.ended_ts);
  }
  for (const end of ends) recordBoundary(end.conversation_id, end.ended_ts);
  for (const fact of events) {
    if (fact.kind !== "conversation.input_queue_changed") continue;
    const event = fact.payload?.input_queue_event;
    if (!event) continue;
    const subjectId = fact.subject.slice("conversation:".length);
    const id = ids.get(subjectId) ?? subjectId;
    const queue = queues.get(id) ?? [];
    queues.set(id, queue);
    // 境界以前の入力は再開した実行へ持ち越さない。
    if ((boundaries.get(id) ?? -Infinity) > Date.parse(fact.source_ts)) continue;
    const text = getMessageText(event.body).trim();
    const normalized = normalizeClaudeContent({ provider: "claude", role: "user", body: event.body });
    const body = normalized.body ?? event.body;
    if (event.operation === "enqueue" && body !== undefined && normalized.role === "user"
      && !/^(?:<(?:agent-message|task-notification)\b|Your claude\.ai usage limit has reset\.)/u.test(text)) {
      queue.push({ id: fact.source_event_id, body, source_ts: normalizeStoredTimestamp(fact.source_ts),
        ...(event.delivery_id ? { delivery_id: event.delivery_id } : {}), state: "queued" });
    } else if (event.operation === "dequeue") {
      queue.shift();
    } else if (event.operation === "popAll") {
      queue.length = 0;
    } else if (event.operation === "remove") {
      const index = queue.findIndex(input => body !== undefined
        && getMessageText(input.body).trim() === getMessageText(body).trim());
      if (index >= 0) queue.splice(index, 1);
    }
  }
  return queues;
}
