export const SOURCES = [
  "host-claude", "host-codex", "hook", "transcript-claude", "rollout-codex",
  "ui", "intake", "kit", "legacy",
] as const;
export type Source = typeof SOURCES[number];
export const CONFIDENCES = ["confirmed", "inferred", "unknown"] as const;
export type Confidence = typeof CONFIDENCES[number];
export type Provider = "claude" | "codex";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RunState = "starting" | "running" | "waiting_approval" | "waiting_input" | "idle" | "ended" | "failed" | "unknown";
export type DelegationState = "received" | "accepted" | "assigned" | "running" | "verifying" | "reviewing" | "done" | "failed" | "interrupted" | "denied";
export type FindingState = "open" | "sent" | "fixed" | "verified" | "dismissed" | "needs_check";
export type RelationKind = "continued" | "forked" | "compacted" | "copied" | "delegated" | "adopted";
export type ConnectionKind = "mcp" | "herdr" | "app" | "pid" | "ws";
export type BodyState = "stored" | "omitted" | "unavailable";

export interface ProjectPayload {
  repository_id: string;
  root_path: string;
  display_name: string;
  name_prefix: string;
  state: "registered" | "unregistered";
}
export interface UnsupportedObservationPayload {
  source_kind: Source;
  file_path: string;
  format_name: string;
  format_version: string;
  reason: string;
}

export interface TaskPayload {
  name?: string;
  purpose: string;
  project: string;
  state: string;
}
export interface ConversationPayload {
  provider: Provider;
  native_id: string;
  origin: "managed" | "observed";
  type: "interactive" | "unattended" | "subagent";
  history_format: "jsonl" | "legacy" | "paginated" | (string & {});
  task_id?: string;
  kit_name?: string;
  // 観測した会話の開始の場所と、git の共通ディレクトリから決めたリポジトリ。
  cwd?: string;
  repository_id?: string;
}
export interface RelationPayload {
  type: RelationKind;
  from_id: string;
  to_id: string;
  evidence: JsonValue;
  confidence: Confidence;
  active: boolean;
}
export interface RunPayload {
  conversation_id: string;
  generation: number;
  state: RunState;
  started_ts?: string;
  ended_ts?: string;
  end_evidence?: JsonValue;
  cause?: string;
  last_evidence?: JsonValue;
  last_evidence_ts?: string;
  reason?: string;
  base_sha?: string;
  pid?: number;
  start_fingerprint?: string;
  repository_id?: string;
  worktree_id?: string;
  // 作業ツリーの場所と枝。runner が起動時に記録する。
  cwd?: string;
  branch?: string;
  // 観測の記録に書かれたモデルと effort。runner の起動の設定は launch に持つ。
  model?: string;
  effort?: string;
}
export interface ConnectionPayload {
  run_id: string;
  type: ConnectionKind;
  fingerprint: string;
  state: string;
  last_evidence?: JsonValue;
  last_evidence_ts?: string;
}
export interface MessagePayload {
  provider: Provider;
  native_id: string;
  version: number;
  role: string;
  phase?: "commentary" | "final_answer";
  body?: JsonValue;
  body_state: BodyState;
  tool_output?: JsonValue;
}
export interface DelegationPayload {
  request_id: string;
  parent_run_id?: string;
  origin?: { provider: Provider; native_id: string };
  role: string;
  title: string;
  task?: string;
  accept?: string[];
  scope?: string[];
  cwd?: string;
  constraints?: JsonValue;
  attempt: number;
  state: DelegationState;
  result?: JsonValue;
}
export interface ArtifactPayload {
  run_id: string;
  version: number;
  repository_id: string;
  worktree_id: string;
  base_sha: string;
  head_sha: string;
  patch_hash: string;
  untracked: string[];
  verification?: JsonValue;
  commits?: string[];
  attribution?: "confirmed" | "inferred" | "joint" | "unknown";
  previous_artifact_id?: string;
  diff?: string;
}
export interface AliasPayload {
  entity_id: string;
  kind: "kit" | "legacy" | (string & {});
  name: string;
}
export interface ApprovalPayload {
  run_id: string;
  connection_id?: string;
  conversation_id?: string;
  request_id: string;
  state: string;
  available_decisions?: string[];
  decision?: string;
  request?: JsonValue;
  reason?: string;
  artifact_id?: string;
  patch_hash?: string;
}
export interface FindingPayload {
  artifact_id: string;
  version: number;
  file: string;
  start_line: number;
  end_line: number;
  side: "old" | "new";
  context_hash: string;
  body?: string;
  severity: string;
  state: FindingState;
}
export interface MessageMembershipPayload {
  message_id: string;
  conversation_id: string;
  active: boolean;
}
export interface EntityPayloads {
  setting: { store: string; fields: string[]; origin: "api" | "file"; revision: string };
  project: ProjectPayload;
  observation: UnsupportedObservationPayload;
  task: TaskPayload;
  conversation: ConversationPayload;
  relation: RelationPayload;
  run: RunPayload;
  connection: ConnectionPayload;
  message: MessagePayload;
  delegation: DelegationPayload;
  artifact: ArtifactPayload;
  alias: AliasPayload;
  approval: ApprovalPayload;
  finding: FindingPayload;
  message_membership: MessageMembershipPayload;
}
export type EntityKind = keyof EntityPayloads;
export const ENTITY_KINDS = [
  "task", "conversation", "relation", "run", "connection", "message", "delegation",
  "artifact", "alias", "approval", "finding", "message_membership",
  "project", "observation", "setting",
] as const satisfies readonly EntityKind[];

// 訂正は同じ実体の部分変更として表し、取り消す事実を必須にする。
export type FactPayloads = {
  [E in Exclude<EntityKind, "observation"> as `${E}.created`]: EntityPayloads[E];
} & {
  [E in Exclude<EntityKind, "observation"> as `${E}.updated`]: Partial<EntityPayloads[E]>;
} & {
  [E in Exclude<EntityKind, "observation"> as `${E}.corrected`]: Partial<EntityPayloads[E]>;
} & {
  "setting.changed": EntityPayloads["setting"];
  "project.state_changed": Pick<ProjectPayload, "state">;
  "observation.unsupported": UnsupportedObservationPayload;
  "task.state_changed": Pick<TaskPayload, "state">;
  "conversation.task_changed": { task_id: string | null };
  "relation.state_changed": Pick<RelationPayload, "active">;
  "run.state_changed": Pick<RunPayload, "state"> & Partial<RunPayload>;
  "run.interrupt_requested": { turn_id: string };
  "connection.state_changed": Pick<ConnectionPayload, "state"> & Partial<ConnectionPayload>;
  "message.version_created": MessagePayload;
  "message.body_state_changed": Pick<MessagePayload, "body_state">;
  "delegation.state_changed": Pick<DelegationPayload, "state" | "attempt"> & Partial<DelegationPayload>;
  "delegation.attempt_created": { attempt: number; run_id?: string; assignment?: JsonValue; verification?: JsonValue; review?: JsonValue };
  "artifact.version_created": ArtifactPayload;
  "approval.answered": { decision: string; reason?: string };
  "approval.resolved": { state: string; reason?: string };
  "approval.state_changed": Pick<ApprovalPayload, "state"> & Partial<ApprovalPayload>;
  "finding.state_changed": Pick<FindingPayload, "state"> & Partial<FindingPayload>;
  "message_membership.state_changed": Pick<MessageMembershipPayload, "active">;
};
export type FactKind = keyof FactPayloads;
export type FactInput = {
  [K in FactKind]: {
    source: Source;
    source_event_id: string;
    kind: K;
    subject: `${EntityKind}:${string}`;
    payload: FactPayloads[K];
    source_ts: string;
    observed_ts?: string;
    cursor?: string | null;
    confidence: Confidence;
  } & (K extends `${string}.corrected` ? { supersedes: string } : { supersedes?: string | null });
}[FactKind];

// 保持整理の後には、どの種類でも payload が null になり得る。
export type Fact = {
  [K in FactKind]: Omit<Extract<FactInput, { kind: K }>, "payload" | "observed_ts" | "cursor" | "supersedes"> & {
    seq: number;
    fact_id: string;
    payload: Partial<FactPayloads[K]> | null;
    payload_hash: string;
    observed_ts: string;
    schema_version: number;
    cursor: string | null;
    supersedes: string | null;
  };
}[FactKind];
