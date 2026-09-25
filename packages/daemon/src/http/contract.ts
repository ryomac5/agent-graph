// ダッシュボード HTTP API の契約。経路と入出力の型をここで固定する。
// 文書は docs/agents/dashboard-api.md。型を変えるときは文書も直す。

export type Status =
  | "planned" | "running" | "waiting" | "waiting_human" | "conflict" | "done"
  | "failed" | "rejected" | "lost" | "timeout" | "denied" | "ended";

export type Family = "anthropic" | "openai";

export interface UsageWindow {
  key: string;
  label: string;
  provider: Family;
  percent: number;
  resetsAt?: string;
}

export interface Usage {
  ts?: string;
  windows: UsageWindow[];
}

export interface ProjectSummary {
  key: string;
  name: string;
  rootPath: string;
  counts: { running: number; waiting: number; failed: number; done: number };
  liveSessions: number;
  lastActivityAt?: string;
  status: "waiting" | "failed" | "running" | "done" | "idle" | "quiet";
}

export interface Overview {
  projects: ProjectSummary[];
  usage: Usage;
  updatedAt: string;
}

export interface AcceptanceResult {
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface Acceptance {
  passed: boolean;
  results: AcceptanceResult[];
  scopeViolations: string[];
}

export interface Review {
  verdict: "approve" | "request_changes";
  comment: string;
  reviewer?: { executor: string; model: string };
}

export interface Round {
  kind: "request" | "reinstruct" | "report";
  text: string;
  at?: string;
}

export interface NodeDetail {
  id: string;
  kind: "root" | "delegation" | "subagent" | "task";
  title: string;
  role?: string;
  status: Status;
  executor?: string;
  model?: string;
  family?: Family;
  parentId?: string;
  startedAt?: string;
  endedAt?: string;
  attempts?: number;
  roundTrips?: number;
  task?: string;
  output?: string;
  feedback?: string;
  acceptance?: Acceptance;
  review?: Review;
  scope?: string[];
  outputs?: string[];
  dependsOn?: string[];
  branch?: string;
  worktree?: string;
  prUrl?: string;
  tokens?: { input: number; output: number };
  assignment?: { reason: string[]; policyVersion: string };
  rounds?: Round[];
}

export interface EdgeDetail {
  id: string;
  from: string;
  to: string;
  kind: "delegate" | "return" | "depends";
  label?: string;
  fromFamily?: Family;
  toFamily?: Family;
}

export interface Turn {
  id: string;
  at: string;
  prompt: string;
  summary?: string;
  hidden?: boolean;
}

export interface SessionView {
  id: string;
  name: string;
  client?: "claude" | "codex" | "planner";
  status: Status;
  waitingReason?: "permission" | "question";
  startedAt: string;
  endedAt?: string;
  goal?: string;
  model?: string;
  turns: Turn[];
  nodes: NodeDetail[];
  edges: EdgeDetail[];
}

// planner のグラフ。タスクは kind task の node、依存は kind depends の edge。
export interface GraphView {
  id: string;
  sessionId?: string;
  goal: string;
  nodes: NodeDetail[];
  edges: EdgeDetail[];
}

export interface ProjectView {
  project: { key: string; name: string; rootPath: string };
  sessions: SessionView[];
  graphs: GraphView[];
  usage: Usage;
  updatedAt: string;
}

export interface ActionRequest {
  action: "approve" | "retry" | "reject" | "end_session" | "hide_turn";
  repo: string;
  graphId?: string;
  taskId?: string;
  sessionId?: string;
  turnId?: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

// 失敗時の共通の応答。
export interface ErrorResult {
  error: string;
}

// index.html に埋め込むトークンの meta 名と、POST に付ける見出し名。
export const TOKEN_META_NAME = "agent-graph-token";
export const TOKEN_HEADER = "x-agent-graph-token";
