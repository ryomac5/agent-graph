import type { DelegationPayload, Fact, FactPayloads, JsonValue } from "../facts.ts";
import { isAbsolute } from "node:path";
import { repoKey } from "../../paths.ts";
import { projectProjects, type ProjectedProject } from "./projects.ts";

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
  root_id?: string | null;
  kit?: JsonValue;
  state: DelegationPayload["state"];
  attempt: number;
  attempts: DelegationAttempt[];
  parent: { confidence: "confirmed" | "unknown"; run_id?: string; conversation_id?: string };
  conflicts: string[];
  // 委譲が属するプロジェクトのリポジトリ。試行の実行、依頼の場所、起動元、キットの記録の順で決める。
  repository_id?: string;
  // 最後に割り当てた実行者とモデル。割り当てがなければキットの記録のモデルを使う。
  provider?: string;
  model?: string;
}

function trimPath(path: string): string { return path.length > 1 ? path.replace(/[\\/]+$/, "") : path; }
const WORKTREE_SEGMENT = /[\\/]agent-graph[\\/]worktrees[\\/]([^\\/]+)(?:[\\/]|$)/;
/**
 * 場所を含むプロジェクトのうち、最も深い本体の場所を持つものを返す。
 * planner と runner の作業ツリーは <cache>/agent-graph/worktrees/<repoKey>/ に置くので、その鍵で本体に結ぶ。
 */
export function matchProjectPath(projects: readonly ProjectedProject[], path: string | undefined): string | undefined {
  if (!path) return undefined;
  const key = WORKTREE_SEGMENT.exec(path)?.[1];
  if (key) {
    const owners = new Set(projects.filter((project) => project.root_path && project.repository_id && isAbsolute(project.root_path)
      && repoKey(trimPath(project.root_path)) === key).map((project) => project.repository_id!));
    if (owners.size === 1) return [...owners][0];
  }
  const target = trimPath(path);
  let best: ProjectedProject | undefined;
  for (const project of projects) {
    if (!project.root_path || !project.repository_id) continue;
    const root = trimPath(project.root_path);
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > trimPath(best.root_path!).length
      || root.length === trimPath(best.root_path!).length && project.id < best.id) best = project;
  }
  return best?.repository_id;
}
/** キットの会話の名前は <前置き>-<番号> である。前置きが一致するプロジェクトが 1 つのときだけ結ぶ。 */
function matchProjectPrefix(projects: readonly ProjectedProject[], session: unknown): string | undefined {
  if (typeof session !== "string") return undefined;
  const prefix = /^(.+)-\d+$/.exec(session)?.[1];
  const matches = new Set(projects.filter((project) => prefix && project.name_prefix === prefix && project.repository_id)
    .map((project) => project.repository_id!));
  return matches.size === 1 ? [...matches][0] : undefined;
}
function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  const runRecords = new Map(projectEntityRecords<FactPayloads["run.created"]>(facts, "run").map((run) => [run.id, run]));
  const runs = new Set(runRecords.keys());
  const projects = projectProjects(facts);
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
    const assignment = readRecord(payload.assignment);
    if (typeof assignment.model === "string" && assignment.model) {
      record.model = assignment.model;
      if (typeof assignment.executor === "string" && assignment.executor) record.provider = assignment.executor;
    }
  }
  for (const record of records.values()) {
    record.attempts.sort((left, right) => left.attempt - right.attempt);
    const latest = record.attempts.at(-1);
    record.attempt = latest?.attempt ?? 0;
    record.state = latest?.state ?? "received";
    if (latest?.result !== undefined) record.result = latest.result;
    record.conflicts.sort();
    const repository = locateDelegation(record);
    if (repository) record.repository_id = repository;
    const kit = readRecord((record as unknown as Record<string, unknown>).kit);
    // キットの codex_start は Codex への依頼である。
    if (!record.model && typeof kit.model === "string" && kit.model) { record.model = kit.model; record.provider ??= "codex"; }
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
  function locateDelegation(record: DelegationProjection): string | undefined {
    for (const attempt of [...record.attempts].reverse()) {
      const repository = attempt.run_id ? runRecords.get(attempt.run_id)?.repository_id : undefined;
      if (repository) return repository;
    }
    const kit = readRecord((record as unknown as Record<string, unknown>).kit);
    const origin = record.origin;
    const originConversation = origin ? conversations.find((conversation) => conversation.provider === origin.provider
      && conversation.native_id === origin.native_id && conversation.repository_id) : undefined;
    return matchProjectPath(projects, record.cwd)
      ?? originConversation?.repository_id
      ?? matchProjectPath(projects, typeof kit.file === "string" ? kit.file : undefined)
      ?? (record.parent_run_id ? runRecords.get(record.parent_run_id)?.repository_id : undefined)
      ?? matchProjectPrefix(projects, kit.session);
  }
}
