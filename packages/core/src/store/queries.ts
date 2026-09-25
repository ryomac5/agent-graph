// ダッシュボードの読み取り用の問い合わせ。契約の形を組む材料を表から集めて返す。
// 組み立ては daemon の views.ts が行う。ここでは表の行を型に直すだけに留める。
import type { DatabaseSync } from "node:sqlite";
import type { AcceptanceResult, ModelFamily } from "../delegate/types.ts";
import type { UsageSample } from "../usage/types.ts";
import type { Repo, SessionRow, SessionStatus, TaskRecord, TaskState, TurnRow, WaitingReason } from "./store.ts";

export type DelegationStatus = "requested" | "planned" | "running" | "waiting" | "done" | "failed" | "timeout" | "denied" | "lost";

export interface DelegationRow {
  id: string;
  repoKey: string;
  sessionId: string;
  parentId?: string;
  taskId?: string;
  kind: "delegation" | "subagent";
  role: string;
  title: string;
  status: DelegationStatus;
  roundTrips: number;
  assignment?: { executor: string; model: string; family: ModelFamily; tier: string; reason: string[]; policyVersion: string };
  acceptance?: AcceptanceResult;
  review?: { verdict: "approve" | "request_changes"; comment: string; reviewerDelegationId: string };
  tokens?: { input: number; output: number };
  // 自分がレビュアーとして出した報告。reviews の comment がその本文になる
  reviewOutput?: string;
  requestedAt?: string;
  finishedAt?: string;
  task?: string;
}

export interface GraphRow {
  id: string;
  repoKey: string;
  sessionId?: string;
  goal: string;
  createdAt: string;
  tasks: TaskRecord[];
}

// planner が graphs に付けた出来事。task.result、task.failed、task.integrated、pr.created など。
export interface GraphEventRow {
  id: string;
  ts: string;
  kind: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; }
  catch { return fallback; }
}

function sessionFromRow(row: Record<string, unknown>): SessionRow {
  return {
    id: String(row.id), repoKey: String(row.repo_key), name: String(row.name), client: String(row.client),
    traceId: String(row.trace_id), startedAt: String(row.started_at), status: String(row.status) as SessionStatus,
    lastSeenAt: String(row.last_seen_at ?? row.started_at),
    ...(text(row.ended_at) === undefined ? {} : { endedAt: String(row.ended_at) }),
    ...(row.pid === null || row.pid === undefined ? {} : { pid: Number(row.pid) }),
    ...(text(row.pid_started_at) === undefined ? {} : { pidStartedAt: String(row.pid_started_at) }),
    ...(text(row.waiting_reason) === undefined ? {} : { waitingReason: String(row.waiting_reason) as WaitingReason }),
    ...(text(row.goal) === undefined ? {} : { goal: String(row.goal) }),
    ...(text(row.model) === undefined ? {} : { model: String(row.model) }),
  };
}

export function getRepo(db: DatabaseSync, key: string): Repo | undefined {
  const row = db.prepare("SELECT key, root_path, name FROM repos WHERE key = ?").get(key);
  return row ? { key: String(row.key), rootPath: String(row.root_path), name: String(row.name) } : undefined;
}

export function listRepos(db: DatabaseSync): Repo[] {
  return db.prepare("SELECT key, root_path, name FROM repos ORDER BY name, key").all()
    .map((row) => ({ key: String(row.key), rootPath: String(row.root_path), name: String(row.name) }));
}

export function listSessions(db: DatabaseSync, repoKey: string): SessionRow[] {
  return db.prepare("SELECT * FROM sessions WHERE repo_key = ? ORDER BY started_at, id").all(repoKey)
    .map((row) => sessionFromRow(row as Record<string, unknown>));
}

// 直近 limit 件を時系列で返す。
export function listRecentTurns(db: DatabaseSync, sessionId: string, limit: number): TurnRow[] {
  return db.prepare(`SELECT * FROM (SELECT *, rowid AS position FROM turns WHERE session_id = ?
      ORDER BY at DESC, rowid DESC LIMIT ?) ORDER BY at, position`).all(sessionId, limit)
    .map((row) => ({
      id: String(row.id), sessionId: String(row.session_id), at: String(row.at), prompt: String(row.prompt),
      ...(text(row.summary) === undefined ? {} : { summary: String(row.summary) }),
      ...(text(row.reply) === undefined ? {} : { reply: String(row.reply) }),
      hidden: Number(row.hidden) === 1,
    }));
}

// 委譲の行に割り当て、受け入れ、レビュー、トークン、開始と終了の時刻、依頼文を合わせる。
export function listDelegations(db: DatabaseSync, repoKey: string): DelegationRow[] {
  const rows = db.prepare(`
    SELECT d.*,
      a.executor, a.model, a.family, a.tier, a.reason, a.policy_version,
      c.passed, c.results, c.scope_violations,
      r.verdict, r.comment, r.reviewer_delegation_id,
      (SELECT comment FROM reviews WHERE reviewer_delegation_id = d.id ORDER BY rowid DESC LIMIT 1) AS review_output,
      (SELECT SUM(input_tokens) FROM token_usage WHERE delegation_id = d.id) AS input_tokens,
      (SELECT SUM(output_tokens) FROM token_usage WHERE delegation_id = d.id) AS output_tokens,
      (SELECT ts FROM events WHERE kind = 'delegation.requested' AND json_extract(payload, '$.delegationId') = d.id
        ORDER BY ts LIMIT 1) AS requested_at,
      (SELECT json_extract(payload, '$.task') FROM events WHERE kind = 'delegation.requested'
        AND json_extract(payload, '$.delegationId') = d.id ORDER BY ts LIMIT 1) AS task,
      (SELECT ts FROM events WHERE kind = 'delegation.finished' AND json_extract(payload, '$.delegationId') = d.id
        ORDER BY ts DESC LIMIT 1) AS finished_at,
      (SELECT started_at FROM spans WHERE name = 'delegate' AND json_extract(attributes, '$."agent.delegation"') = d.id
        ORDER BY started_at LIMIT 1) AS span_started_at
    FROM delegations d
    LEFT JOIN assignments a ON a.delegation_id = d.id
    LEFT JOIN acceptances c ON c.delegation_id = d.id
    LEFT JOIN reviews r ON r.delegation_id = d.id
    WHERE d.repo_key = ?
    ORDER BY d.rowid
  `).all(repoKey) as Record<string, unknown>[];
  return rows.map((row) => {
    const requestedAt = text(row.requested_at) ?? text(row.span_started_at);
    const delegation: DelegationRow = {
      id: String(row.id), repoKey: String(row.repo_key), sessionId: String(row.session_id),
      kind: row.kind === "subagent" ? "subagent" : "delegation",
      role: String(row.role), title: String(row.title), status: String(row.status) as DelegationStatus,
      roundTrips: Number(row.round_trips ?? 0),
    };
    if (text(row.parent_id) !== undefined) delegation.parentId = String(row.parent_id);
    if (text(row.task_id) !== undefined) delegation.taskId = String(row.task_id);
    if (text(row.executor) !== undefined) {
      delegation.assignment = { executor: String(row.executor), model: String(row.model),
        family: String(row.family) as ModelFamily, tier: String(row.tier),
        reason: parseJson<string[]>(row.reason, []), policyVersion: String(row.policy_version) };
    }
    if (row.passed !== null && row.passed !== undefined) {
      delegation.acceptance = { passed: Number(row.passed) === 1,
        results: parseJson<AcceptanceResult["results"]>(row.results, []),
        scopeViolations: parseJson<string[]>(row.scope_violations, []) };
    }
    if (text(row.verdict) !== undefined) {
      delegation.review = { verdict: row.verdict === "approve" ? "approve" : "request_changes",
        comment: String(row.comment ?? ""), reviewerDelegationId: String(row.reviewer_delegation_id) };
    }
    if (row.input_tokens !== null && row.input_tokens !== undefined) {
      delegation.tokens = { input: Number(row.input_tokens), output: Number(row.output_tokens ?? 0) };
    }
    if (text(row.review_output) !== undefined) delegation.reviewOutput = String(row.review_output);
    if (requestedAt !== undefined) delegation.requestedAt = requestedAt;
    if (text(row.finished_at) !== undefined) delegation.finishedAt = String(row.finished_at);
    if (text(row.task) !== undefined) delegation.task = String(row.task);
    return delegation;
  });
}

export function listGraphs(db: DatabaseSync, repoKey: string): GraphRow[] {
  const tasks = db.prepare("SELECT * FROM tasks WHERE graph_id = ? ORDER BY rowid");
  return db.prepare("SELECT * FROM graphs WHERE repo_key = ? ORDER BY created_at, rowid").all(repoKey).map((row) => {
    const id = String(row.id);
    return {
      id, repoKey: String(row.repo_key), goal: String(row.goal), createdAt: String(row.created_at),
      ...(text(row.session_id) === undefined ? {} : { sessionId: String(row.session_id) }),
      tasks: tasks.all(id).map((task) => ({
        graphId: id, id: String(task.id), title: String(task.title), role: String(task.role),
        dependsOn: parseJson<string[]>(task.depends_on, []), state: String(task.state) as TaskState,
        attempts: Number(task.attempts),
      })),
    };
  });
}

// planner.* の出来事を時系列で返す。kind は planner. を外した名前。
export function listGraphEvents(db: DatabaseSync, graphId: string): GraphEventRow[] {
  return db.prepare(`SELECT id, ts, kind, payload FROM events
      WHERE kind LIKE 'planner.%' AND json_extract(payload, '$.graphId') = ? ORDER BY ts, rowid`).all(graphId)
    .map((row) => {
      const payload = parseJson<Record<string, unknown>>(row.payload, {});
      return { id: String(row.id), ts: String(row.ts), kind: String(row.kind).slice("planner.".length),
        ...(typeof payload.taskId === "string" ? { taskId: payload.taskId } : {}), payload };
    });
}

// provider と model と window ごとの最新の記録。
export function latestUsageSamples(db: DatabaseSync): UsageSample[] {
  return db.prepare(`
    SELECT ts, provider, window, percent, resets_at, model FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY provider, model, window ORDER BY ts DESC, rowid DESC) AS position
      FROM usage_samples
    ) WHERE position = 1 ORDER BY provider, model, window
  `).all().map((row) => ({
    ts: String(row.ts), provider: String(row.provider) as UsageSample["provider"],
    window: String(row.window), percent: Number(row.percent),
    ...(text(row.resets_at) === undefined ? {} : { resetsAt: String(row.resets_at) }),
    ...(text(row.model) === undefined ? {} : { model: String(row.model) }),
  }));
}

// リポジトリの最後の動き。セッションの記録、turn、出来事のうち最も新しい時刻。
export function lastActivityAt(db: DatabaseSync, repoKey: string): string | undefined {
  const row = db.prepare(`
    SELECT MAX(ts) AS ts FROM (
      SELECT MAX(last_seen_at) AS ts FROM sessions WHERE repo_key = ?
      UNION ALL SELECT MAX(ended_at) FROM sessions WHERE repo_key = ?
      UNION ALL SELECT MAX(t.at) FROM turns t JOIN sessions s ON s.id = t.session_id WHERE s.repo_key = ?
      UNION ALL SELECT MAX(ts) FROM events WHERE repo_key = ? AND kind != 'usage.sampled'
    )
  `).get(repoKey, repoKey, repoKey, repoKey);
  return text(row?.ts);
}
