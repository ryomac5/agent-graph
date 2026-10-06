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
  // 一覧のカードに出す直近のセッション。生きたものを新しい順に、無ければ最後に終わったもの 1 つ
  sessions: SessionDigest[];
}

export interface SessionDigest {
  id: string;
  name: string;
  client?: "claude" | "codex" | "planner";
  model?: string;
  status: Status;
  waitingReason?: "permission" | "question";
  lastPrompt?: string;
  lastAt: string;
  delegations: number;
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
  reply?: string;
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
  // この会話を作る会話 ID の鎖。Claude Code は会話を裏に回すと別の ID で続けるので、鎖を 1 つの会話として見せる。
  // id は鎖の末尾で、今の操作を受ける会話 ID
  memberIds: string[];
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
  action: "approve" | "retry" | "reject" | "end_session" | "hide_turn" | "new_session" | "set_model" | "rerun_delegation" | "stop_session";
  repo: string;
  graphId?: string;
  taskId?: string;
  sessionId?: string;
  turnId?: string;
  delegationId?: string;
  model?: string;
  // set_model のときの effort。選んだモデルが受け付ける段階だけ
  effort?: string;
  client?: "claude" | "codex";
}

// 変更できるモデル 1 つ。id は /model に渡す名前、efforts は選べる段階。空なら effort を選べない
export interface ModelChoice { id: string; label: string; efforts: string[]; defaultEffort?: string }
export interface ModelCatalog { claude: ModelChoice[]; codex: ModelChoice[] }

export interface ActionResult {
  ok: boolean;
  message: string;
}

// ダッシュボードから Claude セッションへメッセージを送る。
export interface SayRequest {
  repo: string;
  sessionId: string;
  text: string;
}

// 失敗時の共通の応答。
export interface ErrorResult {
  error: string;
}

// index.html に埋め込むトークンの meta 名と、POST に付ける見出し名。
export const TOKEN_META_NAME = "agent-graph-token";
export const TOKEN_HEADER = "x-agent-graph-token";
