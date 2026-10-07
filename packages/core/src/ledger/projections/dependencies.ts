import type { Fact } from "../facts.ts";

export const PROJECTION_ENTITIES = {
  tasks: ["task"],
  // 会話の本体は会話と作業、仮名は索引付きの有効な発言候補に依存する。
  conversations: ["conversation", "task"],
  relations: ["relation", "conversation"],
  runs: ["run"],
  connections: ["connection"],
  messages: ["message"],
  // 委譲のプロジェクトは、登録したプロジェクトの本体の場所と前置きから決める。
  delegations: ["delegation", "run", "conversation", "project"],
  artifacts: ["artifact"],
  aliases: ["alias"],
  approvals: ["approval", "artifact", "run"],
  findings: ["finding"],
  message_memberships: ["message_membership", "message", "conversation"],
} as const;
export type ProjectionTable = keyof typeof PROJECTION_ENTITIES;
export interface ProjectionDependency {
  projection: ProjectionTable;
  direction: "needs" | "offers";
  key: string;
}

export function readNativeReference(value: string): string | undefined {
  if (!value.startsWith("[")) return undefined;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2
      && typeof parts[0] === "string" && typeof parts[1] === "string" ? parts[1] : undefined;
  } catch { return undefined; }
}

/** 参照は片方向、同一性と版の連鎖は双方向。部分訂正の旧参照も履歴に残す。 */
export function collectProjectionDependencies(fact: Fact): ProjectionDependency[] {
  const entity = fact.kind.split(".")[0];
  const id = fact.subject.slice(entity.length + 1);
  const payload = (fact.payload ?? {}) as Record<string, unknown>;
  const result: ProjectionDependency[] = [];
  for (const [projection, entities] of Object.entries(PROJECTION_ENTITIES)) {
    if (!(entities as readonly string[]).includes(entity)) continue;
    const add = (direction: ProjectionDependency["direction"], key: string) => {
      result.push({ projection: projection as ProjectionTable, direction, key });
    };
    const need = (target: string, value: unknown) => {
      if (typeof value !== "string") return;
      add("needs", `${target}:${value}`);
      if (target === "conversation" || target === "message") {
        const native = readNativeReference(value);
        if (native !== undefined) add("needs", `${target}-native:${native}`);
      }
    };
    const share = (key: string) => { add("needs", key); add("offers", key); };
    add("offers", fact.subject);
    // 訂正が別 subject を参照しても純粋な投影と同じ事実の集合を渡す。
    add("offers", `fact:${fact.fact_id}`);
    if (fact.supersedes) share(`fact:${fact.supersedes}`);
    if (entity === "conversation" || entity === "message") {
      // provider が部分訂正で省略されても、候補を取りこぼさない。
      if (typeof payload.native_id === "string") share(`${entity}-native:${payload.native_id}`);
    }
    if (entity === "conversation" && projection === "conversations") {
      need("task", payload.task_id);
    }
    if (entity === "message" && projection === "message_memberships") {
      add("needs", `membership-message:${id}`);
      if (typeof payload.native_id === "string") add("needs", `membership-native:${payload.native_id}`);
    }
    if (entity === "message_membership") {
      need("message", payload.message_id);
      need("conversation", payload.conversation_id);
      // 同じ所属を複数の subject で観測した場合も統合する。
      if (typeof payload.message_id === "string") share(`membership-message:${payload.message_id}`);
      if (typeof payload.message_id === "string") {
        const native = readNativeReference(payload.message_id);
        if (native !== undefined) share(`membership-native:${native}`);
      }
    }
    if (entity === "relation") {
      need("conversation", payload.from_id);
      need("conversation", payload.to_id);
      // 端点の部分変更でも同一の関係の候補をすべて含める。
      if (typeof payload.from_id === "string") share(`relation-from:${payload.from_id}`);
    }
    if (entity === "project" && projection === "delegations") add("offers", "projects");
    if (entity === "delegation") {
      add("needs", "projects");
      need("run", payload.parent_run_id);
      need("run", payload.run_id);
      if (typeof payload.request_id === "string") share(`request:${payload.request_id}`);
      const origin = payload.origin as { native_id?: string } | undefined;
      if (origin?.native_id) add("needs", `conversation-native:${origin.native_id}`);
    }
    if (entity === "artifact") {
      // 同じ subject の後続版は版付きの行 ID で承認から参照される。
      if (typeof payload.version === "number") add("offers", `artifact:${id}@${payload.version}`);
      if (typeof payload.run_id === "string") share(`artifact-run:${payload.run_id}`);
      share(`artifact-chain:${id}`);
      if (typeof payload.previous_artifact_id === "string") share(`artifact-chain:${payload.previous_artifact_id}`);
    }
    if (entity === "approval") {
      need("run", payload.run_id);
      need("artifact", payload.artifact_id);
    }
    if (entity === "alias" && typeof payload.name === "string") share(`alias-name:${payload.name}`);
    // 実行の投影 ID は会話と世代から決まる。同じ ID の候補を含める。
    if (entity === "run" && projection === "runs" && typeof payload.conversation_id === "string") {
      share(`run-conversation:${payload.conversation_id}`);
    }
  }
  return result;
}
