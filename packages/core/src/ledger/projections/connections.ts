import { expandNativeEvidenceSet } from '../native-evidence.ts';
import type { ConnectionPayload, Fact } from "../facts.ts";
import { normalizeTimestampFields } from "../timestamps.ts";

export interface ConnectionProjection extends ConnectionPayload { id: string }

// 訂正対象を集合から除き、到着順と seq を投影に使わない。
export function orderActiveFacts(facts: readonly Fact[]): Fact[] {
  facts = expandNativeEvidenceSet(facts);
  const superseded = new Set(facts.flatMap((fact) => fact.supersedes ? [fact.supersedes] : []));
  const active = facts.filter((fact) => !superseded.has(fact.fact_id));
  // 比較のたびに時刻を解釈しない。並びは各事実の Date.parse の値で決まり、結果は変わらない。
  const times = new Map(active.map((fact) => [fact, Date.parse(fact.source_ts)]));
  return active.sort((left, right) =>
    times.get(left)! - times.get(right)!
    || compareStateVersion(left, right)
    || compareText(left.source_event_id, right.source_event_id)
    || compareText(left.source, right.source));
}

// 同じ Codex 状態の再導出は版の数値で並べ、追記済みの ID は変えない。
function compareStateVersion(left: Fact, right: Fact): number {
  if (left.source !== "rollout-codex" || right.source !== "rollout-codex"
    || left.kind !== "run.state_changed" || right.kind !== "run.state_changed") return 0;
  const a = /^(.*:state)(?::v(\d+))?$/.exec(left.source_event_id);
  const b = /^(.*:state)(?::v(\d+))?$/.exec(right.source_event_id);
  return a && b && a[1] === b[1] ? Number(a[2] ?? 0) - Number(b[2] ?? 0) : 0;
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
  return [...connections.values()].map(normalizeTimestampFields).sort((left, right) => compareText(left.id, right.id));
}
