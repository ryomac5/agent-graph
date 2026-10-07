import type { EntityKind, EntityPayloads, Fact, JsonValue, RelationPayload } from "../facts.ts";

export type ProjectedEntity<E extends EntityKind> = { id: string } & Partial<EntityPayloads[E]>;

export function compareFacts(left: Fact, right: Fact): number {
  return Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || compareText(left.source_event_id, right.source_event_id)
    || compareText(left.source, right.source)
    || compareText(left.fact_id, right.fact_id);
}
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
export function createNativeId(provider: string, nativeId: string): string {
  return JSON.stringify([provider, nativeId]);
}
// 投影の中で組んだ値は未定義の欄を持ち得る。JSON と同じく、欄は省き、配列の要素は null にする。
export function serializeValue(value: JsonValue | undefined): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${serializeValue(value[key])}`).join(",")}}`;
}

// 部分訂正は元の未変更の列を継承する。元の事実そのものは競合候補から外す。
export function projectEntities<E extends EntityKind>(
  facts: readonly Fact[], entity: E,
  identify: (payload: Partial<EntityPayloads[E]>, subjectId: string) => string = (_, id) => id,
  prioritize: (fact: Fact, payload: Partial<EntityPayloads[E]>) => readonly number[] = () => [],
): ProjectedEntity<E>[] {
  const relevant = [...new Map(facts.filter((fact) => fact.kind.startsWith(`${entity}.`))
    .map((fact) => [fact.fact_id, fact])).values()];
  const byFactId = new Map(relevant.map((fact) => [fact.fact_id, fact]));
  const superseded = new Set(relevant.filter((fact) => {
    const previous = fact.supersedes && byFactId.get(fact.supersedes);
    return previous && previous.subject === fact.subject;
  }).map((fact) => fact.supersedes));
  function readPayload(fact: Fact, visited?: Set<string>): Partial<EntityPayloads[E]> {
    const previous = fact.supersedes && byFactId.get(fact.supersedes);
    if (!previous || previous.subject !== fact.subject) return (fact.payload ?? {}) as Partial<EntityPayloads[E]>;
    const chain = visited ?? new Set<string>();
    if (chain.has(fact.fact_id)) return {};
    chain.add(fact.fact_id);
    const inherited = readPayload(previous, chain);
    return { ...inherited, ...fact.payload } as Partial<EntityPayloads[E]>;
  }
  const candidates = relevant.filter((fact) => !superseded.has(fact.fact_id));
  function isCreation(fact: Fact, visited?: Set<string>): boolean {
    if (fact.kind.endsWith(".created") || fact.kind.endsWith(".version_created")) return true;
    const previous = fact.supersedes && byFactId.get(fact.supersedes);
    if (!previous || previous.subject !== fact.subject) return false;
    const chain = visited ?? new Set<string>();
    if (chain.has(fact.fact_id)) return false;
    chain.add(fact.fact_id);
    return isCreation(previous, chain);
  }
  const creations = candidates.filter((fact) => isCreation(fact));
  creations.sort((left, right) => {
    const leftPriority = prioritize(left, readPayload(left));
    const rightPriority = prioritize(right, readPayload(right));
    for (let index = 0; index < Math.max(leftPriority.length, rightPriority.length); index += 1) {
      const difference = (leftPriority[index] ?? 0) - (rightPriority[index] ?? 0);
      if (difference) return difference;
    }
    return compareFacts(left, right);
  });
  const ordered = [...creations, ...candidates.filter((fact) => !isCreation(fact)).sort(compareFacts)];
  function mergeRows(resolveId: (subjectId: string) => string): Map<string, ProjectedEntity<E>> {
    const rows = new Map<string, ProjectedEntity<E>>();
    const fieldFacts = new Map<string, Map<string, Fact>>();
    // 出所の優先は作成・版の競合だけに使い、変更は列ごとに時刻で反映する。
    for (const fact of ordered) {
      const id = resolveId(fact.subject.slice(entity.length + 1));
      const fields = fieldFacts.get(id) ?? new Map<string, Fact>();
      const payload = { ...readPayload(fact) };
      for (const key of Object.keys(payload)) {
        const previous = fields.get(key);
        if (!isCreation(fact) && previous && compareFacts(fact, previous) < 0) {
          delete payload[key as keyof EntityPayloads[E]];
        } else {
          fields.set(key, fact);
        }
      }
      fieldFacts.set(id, fields);
      rows.set(id, { ...rows.get(id), ...payload, id });
    }
    return rows;
  }
  // 識別にも訂正と出所の優先を適用し、端点と所属で同じ ID を使う。
  const original = mergeRows((id) => id);
  const identities = new Map([...original].map(([id, row]) => [id, identify(row, id)]));
  const rows = [...identities].some(([id, canonical]) => id !== canonical)
    ? mergeRows((id) => identities.get(id)!) : original;
  return [...rows.values()].sort((left, right) => compareText(left.id, right.id));
}

export type ProjectedRelation = ProjectedEntity<"relation">;
export function projectConversationIds(facts: readonly Fact[]): Map<string, string> {
  return new Map(projectEntities(facts, "conversation", undefined,
    (fact) => [fact.source.startsWith("host-") ? 1 : 0]).map((conversation) => [conversation.id,
    conversation.provider && conversation.native_id
      ? createNativeId(conversation.provider, conversation.native_id) : conversation.id]));
}

export function projectRelations(facts: readonly Fact[]): ProjectedRelation[] {
  const conversationIds = projectConversationIds(facts);
  const resolveId = (id: string) => conversationIds.get(id) ?? id;
  return projectEntities(facts, "relation", (payload, id) => {
    if (!payload.type || !payload.from_id || !payload.to_id || payload.evidence === undefined) return id;
    return JSON.stringify([payload.type, resolveId(payload.from_id), resolveId(payload.to_id), serializeValue(payload.evidence)]);
  }, (fact) => [fact.source === "ui" ? 2 : fact.source === "intake" ? 1 : 0]).map((relation) => ({
    ...relation,
    from_id: relation.from_id === undefined ? undefined : resolveId(relation.from_id),
    to_id: relation.to_id === undefined ? undefined : resolveId(relation.to_id),
  }));
}

export function selectConfirmedRelations(relations: readonly ProjectedRelation[]): (ProjectedRelation & RelationPayload)[] {
  return relations.filter((relation): relation is ProjectedRelation & RelationPayload =>
    relation.active === true && relation.confidence === "confirmed"
    && relation.type !== undefined && relation.from_id !== undefined && relation.to_id !== undefined
    && relation.evidence !== undefined);
}

// 操作も表示と同じ訂正済みの投影から端点を選ぶ。保存時の関係 ID も受け付ける。
export function resolveRelationTarget(facts: readonly Fact[], relationId: string, side: "from" | "to" = "to"): string {
  const relations = projectRelations(facts);
  const subjectFacts = facts.filter((fact) => fact.subject === `relation:${relationId}`);
  const identity = projectRelations(subjectFacts.length ? [...facts.filter((fact) => fact.kind.startsWith("conversation.")), ...subjectFacts] : []).at(0)?.id;
  const relation = relations.find((entry) => entry.id === (identity ?? relationId));
  const target = side === "from" ? relation?.from_id : relation?.to_id;
  if (!relation?.active || !target) throw new Error("Active relation target unavailable");
  return target;
}
