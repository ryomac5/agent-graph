import type { ConnectionPayload, Fact } from "../facts.ts";

export interface ConnectionProjection extends ConnectionPayload { id: string }

// 訂正対象を集合から除き、到着順と seq を投影に使わない。
export function orderActiveFacts(facts: readonly Fact[]): Fact[] {
  const superseded = new Set(facts.flatMap((fact) => fact.supersedes ? [fact.supersedes] : []));
  return facts.filter((fact) => !superseded.has(fact.fact_id)).sort((left, right) =>
    Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || compareText(left.source_event_id, right.source_event_id)
    || compareText(left.source, right.source));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function projectConnections(facts: readonly Fact[]): ConnectionProjection[] {
  const connections = new Map<string, ConnectionProjection>();
  for (const fact of orderActiveFacts(facts)) {
    if (!fact.kind.startsWith("connection.") || !fact.payload) continue;
    const payload = fact.payload as Partial<ConnectionPayload>;
    const id = fact.subject.slice("connection:".length);
    const previous = connections.get(id);
    const merged = { ...previous, ...payload, id };
    if (!merged.run_id || !merged.type || merged.fingerprint === undefined || !merged.state) continue;
    connections.set(id, {
      ...merged,
      last_evidence: payload.last_evidence ?? { fact_id: fact.fact_id, kind: fact.kind },
      last_evidence_ts: payload.last_evidence_ts ?? fact.source_ts,
    } as ConnectionProjection);
  }
  return [...connections.values()].sort((left, right) => compareText(left.id, right.id));
}
