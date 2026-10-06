import type { DelegationPayload, Fact, FactPayloads, JsonValue } from "../facts.ts";

export interface DelegationAttempt {
  attempt: number;
  state?: DelegationPayload["state"];
  run_id?: string;
  assignment?: JsonValue;
  verification?: JsonValue;
  review?: JsonValue;
  result?: JsonValue;
}
export interface DelegationProjection extends Partial<DelegationPayload> {
  id: string;
  request_id: string;
  state: DelegationPayload["state"];
  attempt: number;
  attempts: DelegationAttempt[];
  parent: { confidence: "confirmed" | "unknown"; run_id?: string; conversation_id?: string };
  conflicts: string[];
}

// 訂正の部分変更は元の内容を引き継ぎ、取り消された事実自体は適用しない。
export function prepareProjectionFacts(facts: readonly Fact[]): Fact[] {
  const byId = new Map(facts.map((fact) => [fact.fact_id, fact]));
  const superseded = new Set(facts.flatMap((fact) => fact.supersedes ? [fact.supersedes] : []));
  function resolvePayload(fact: Fact, seen = new Set<string>()): Fact["payload"] {
    if (!fact.supersedes || seen.has(fact.fact_id)) return fact.payload;
    seen.add(fact.fact_id);
    const previous = byId.get(fact.supersedes);
    return { ...(previous ? resolvePayload(previous, seen) : {}), ...fact.payload };
  }
  function resolveKind(fact: Fact): Fact["kind"] {
    const seen = new Set<string>();
    let current = fact;
    while (current.kind.endsWith(".corrected") && current.supersedes && !seen.has(current.fact_id)) {
      seen.add(current.fact_id);
      const previous = byId.get(current.supersedes);
      if (!previous || previous.subject !== fact.subject) break;
      current = previous;
    }
    return current.kind;
  }
  return [...byId.values()].filter((fact) => !superseded.has(fact.fact_id))
    .map((fact) => ({ ...fact, kind: resolveKind(fact), payload: resolvePayload(fact) } as Fact))
    .sort(compareProjectionFacts);
}
export function compareProjectionFacts(left: Fact, right: Fact): number {
  return Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || left.source_event_id.localeCompare(right.source_event_id)
    || left.source.localeCompare(right.source)
    || left.fact_id.localeCompare(right.fact_id);
}
export function projectEntityRecords<P extends object>(facts: readonly Fact[], entity: string): (Partial<P> & { id: string })[] {
  const records = new Map<string, Partial<P> & { id: string }>();
  for (const fact of prepareProjectionFacts(facts)) {
    if (!fact.kind.startsWith(`${entity}.`) || !fact.payload) continue;
    const id = fact.subject.slice(entity.length + 1);
    records.set(id, { ...records.get(id), ...fact.payload, id } as Partial<P> & { id: string });
  }
  return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
}
function serializeRequest(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeRequest).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${serializeRequest(record[key])}`).join(",")}}`;
}
function selectRequest(payload: Partial<DelegationPayload>): Partial<DelegationPayload> {
  const { attempt, state, result, ...request } = payload;
  return request;
}

export function projectDelegations(facts: readonly Fact[]): DelegationProjection[] {
  const active = prepareProjectionFacts(facts);
  const conversations = projectEntityRecords<FactPayloads["conversation.created"]>(facts, "conversation");
  const runs = new Set(projectEntityRecords<FactPayloads["run.created"]>(facts, "run").map((run) => run.id));
  const records = new Map<string, DelegationProjection>();
  const subjects = new Map<string, string>();
  const requests = new Map<string, string>();
  const rejected = new Set<string>();
  // 再送の照合は訂正前の依頼で行い、訂正は照合後に重ねる。
  const creations = [...new Map([...facts.filter((fact) => fact.kind === "delegation.created"),
    ...active.filter((fact) => fact.kind === "delegation.corrected")].map((fact) => [fact.fact_id, fact])).values()];
  // 受付の依頼を正とし、他の出所も矛盾検出の対象に残す。
  creations.sort((left, right) => Number(right.source === "intake") - Number(left.source === "intake") || compareProjectionFacts(left, right));
  for (const fact of creations) {
    const payload = fact.payload as Partial<DelegationPayload> | null;
    if (!payload?.request_id) continue;
    const signature = serializeRequest(selectRequest(payload));
    const existing = records.get(payload.request_id);
    if (existing) {
      if (requests.get(payload.request_id) !== signature) {
        existing.conflicts.push(fact.fact_id);
        rejected.add(fact.fact_id);
      } else {
        subjects.set(fact.subject, payload.request_id);
      }
      continue;
    }
    requests.set(payload.request_id, signature);
    subjects.set(fact.subject, payload.request_id);
    records.set(payload.request_id, {
      ...selectRequest(payload), id: payload.request_id, request_id: payload.request_id,
      state: payload.state ?? "received", attempt: payload.attempt ?? 0,
      attempts: payload.attempt === undefined ? [] : [{ attempt: payload.attempt, state: payload.state, result: payload.result }],
      parent: { confidence: "unknown" }, conflicts: [],
    });
  }
  for (const fact of active) {
    if (fact.kind !== "delegation.created" || !fact.supersedes || !fact.payload) continue;
    const requestId = subjects.get(fact.subject);
    const record = requestId ? records.get(requestId) : undefined;
    if (!record) continue;
    const payload = fact.payload as Partial<DelegationPayload>;
    Object.assign(record, selectRequest(payload));
    if (payload.attempt !== undefined) {
      const attempt = record.attempts.find((item) => item.attempt === payload.attempt);
      const corrected = { attempt: payload.attempt, state: payload.state, result: payload.result };
      if (attempt) Object.assign(attempt, corrected);
      else record.attempts.push(corrected);
    }
  }
  for (const fact of active) {
    if (!fact.kind.startsWith("delegation.") || !fact.payload || rejected.has(fact.fact_id)) continue;
    if (fact.kind === "delegation.created" || fact.kind === "delegation.corrected") continue;
    const payload = fact.payload as Partial<DelegationPayload & FactPayloads["delegation.attempt_created"]>;
    // 受理した subject だけを更新し、request_id で矛盾した依頼を結び直さない。
    const requestId = subjects.get(fact.subject);
    const record = requestId ? records.get(requestId) : undefined;
    if (!record || payload.attempt === undefined) continue;
    let attempt = record.attempts.find((item) => item.attempt === payload.attempt);
    if (!attempt) { attempt = { attempt: payload.attempt }; record.attempts.push(attempt); }
    for (const key of ["state", "run_id", "assignment", "verification", "review", "result"] as const) {
      if (payload[key] !== undefined) Object.assign(attempt, { [key]: payload[key] });
    }
  }
  for (const record of records.values()) {
    record.attempts.sort((left, right) => left.attempt - right.attempt);
    const latest = record.attempts.at(-1);
    record.attempt = latest?.attempt ?? 0;
    record.state = latest?.state ?? "received";
    if (latest?.result !== undefined) record.result = latest.result;
    record.conflicts.sort();
    const requestFact = creations.find((fact) => (fact.payload as Partial<DelegationPayload> | null)?.request_id === record.request_id);
    if (requestFact?.confidence !== "confirmed") continue;
    if (record.parent_run_id) {
      if (runs.has(record.parent_run_id)) record.parent = { confidence: "confirmed", run_id: record.parent_run_id };
    } else if (record.origin) {
      const origin = record.origin;
      const matches = conversations.filter((conversation) => conversation.provider === origin.provider && conversation.native_id === origin.native_id);
      if (matches.length === 1) record.parent = { confidence: "confirmed", conversation_id: matches[0].id };
    }
  }
  return [...records.values()].sort((left, right) => left.id.localeCompare(right.id));
}
