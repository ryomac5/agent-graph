// 契約の Overview と ProjectView を store の表から組み立てる。
// 材料は core の queries.ts が返す。ここでは形を合わせるだけで、表には触らない。
import type { Store, TaskState } from "../../../core/src/store/store.ts";
import {
  getRepo, lastActivityAt, latestUsageSamples, listDelegations, listGraphEvents, listGraphs, listRecentTurns,
  listRepos, listSessions, type DelegationRow, type DelegationStatus, type GraphEventRow, type GraphRow,
} from "../../../core/src/store/queries.ts";
import type { UsageSample } from "../../../core/src/usage/types.ts";
import type {
  EdgeDetail, Family, GraphView, NodeDetail, Overview, ProjectSummary, ProjectView, Round, SessionView, Status,
  Turn, Usage, UsageWindow,
} from "./contract.ts";

export const TURN_LIMIT = 50;
export const RETURN_LABEL_LIMIT = 80;
export const DEPENDS_LABEL_FILES = 3;
export const QUIET_AFTER_MS = 24 * 60 * 60_000;

// 子から親へ戻る辺を引く状態。実行が終わって報告があり得るもの。
const RETURNED_STATUSES = new Set<DelegationStatus>(["done", "failed", "timeout"]);
const WAITING_STATUSES = new Set<Status>(["waiting", "waiting_human", "conflict"]);
const FAILED_STATUSES = new Set<Status>(["failed", "rejected", "timeout", "denied", "lost"]);
const PROVIDER_LABELS: Record<Family, string> = { anthropic: "Claude", openai: "Codex" };
const PROVIDER_ORDER: Record<Family, number> = { anthropic: 0, openai: 1 };

function familyOf(client: string): Family | undefined {
  if (client === "claude") return "anthropic";
  if (client === "codex") return "openai";
  return undefined;
}

function delegationStatus(status: DelegationStatus): Status {
  return status === "requested" ? "planned" : status;
}

function taskStatus(state: TaskState): Status {
  if (state === "verifying" || state === "reviewing" || state === "merging") return "running";
  return state;
}

function firstLine(text: string, limit: number): string {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

// 再指示の材料。受け入れの失敗かレビューの修正依頼。run.ts が子に返す内容と揃える。
function feedbackOf(row: DelegationRow): string | undefined {
  if (row.acceptance && !row.acceptance.passed) {
    const lines = row.acceptance.results.filter((result) => result.exitCode !== 0)
      .map((result) => `exit ${result.exitCode}: ${result.command}`);
    for (const violation of row.acceptance.scopeViolations) lines.push(`scope 外: ${violation}`);
    return ["受け入れ失敗", ...lines].join("\n");
  }
  if (row.review?.verdict === "request_changes") return `レビューの修正依頼:\n${row.review.comment}`;
  return undefined;
}

interface DelegationContext {
  byId: Map<string, DelegationRow>;
  // planner の task.result が持つ出力。delegationId で引く
  outputs: Map<string, string>;
}

function outputOf(row: DelegationRow, context: DelegationContext): string | undefined {
  return row.reviewOutput ?? context.outputs.get(row.id);
}

// 委譲の行から NodeDetail の詳細の項目を組む。task の node にも同じものを重ねる。
function delegationDetail(row: DelegationRow, context: DelegationContext): Partial<NodeDetail> {
  const detail: Partial<NodeDetail> = { roundTrips: row.roundTrips };
  if (row.assignment) {
    detail.executor = row.assignment.executor;
    detail.model = row.assignment.model;
    detail.family = row.assignment.family;
    detail.assignment = { reason: row.assignment.reason, policyVersion: row.assignment.policyVersion };
  }
  if (row.requestedAt !== undefined) detail.startedAt = row.requestedAt;
  if (row.finishedAt !== undefined) detail.endedAt = row.finishedAt;
  if (row.task !== undefined) detail.task = row.task;
  const output = outputOf(row, context);
  if (output !== undefined) detail.output = output;
  const feedback = feedbackOf(row);
  if (feedback !== undefined) detail.feedback = feedback;
  if (row.acceptance) detail.acceptance = row.acceptance;
  if (row.review) {
    const reviewer = context.byId.get(row.review.reviewerDelegationId)?.assignment;
    detail.review = { verdict: row.review.verdict, comment: row.review.comment,
      ...(reviewer ? { reviewer: { executor: reviewer.executor, model: reviewer.model } } : {}) };
  }
  if (row.tokens) detail.tokens = row.tokens;
  const rounds: Round[] = [];
  if (row.task !== undefined) rounds.push({ kind: "request", text: row.task, ...(row.requestedAt ? { at: row.requestedAt } : {}) });
  if (output !== undefined) rounds.push({ kind: "report", text: output, ...(row.finishedAt ? { at: row.finishedAt } : {}) });
  if (rounds.length) detail.rounds = rounds;
  return detail;
}

function delegationNode(row: DelegationRow, context: DelegationContext): NodeDetail {
  return {
    id: row.id, kind: row.kind, title: row.title, role: row.role, status: delegationStatus(row.status),
    parentId: row.parentId ?? row.sessionId, ...delegationDetail(row, context),
  };
}

function turnView(turn: { id: string; at: string; prompt: string; summary?: string; hidden: boolean }): Turn {
  return { id: turn.id, at: turn.at, prompt: turn.prompt,
    ...(turn.summary === undefined ? {} : { summary: turn.summary }), ...(turn.hidden ? { hidden: true } : {}) };
}

function sessionView(store: Store, session: ReturnType<typeof listSessions>[number], rows: DelegationRow[],
  context: DelegationContext): SessionView {
  const family = familyOf(session.client);
  const root: NodeDetail = {
    id: session.id, kind: "root", title: session.name, role: "root", status: session.status,
    executor: session.client, startedAt: session.startedAt,
    ...(family ? { family } : {}), ...(session.model ? { model: session.model } : {}),
    ...(session.endedAt ? { endedAt: session.endedAt } : {}), ...(session.goal ? { task: session.goal } : {}),
  };
  const nodes: NodeDetail[] = [root, ...rows.map((row) => delegationNode(row, context))];
  const families = new Map(nodes.map((node) => [node.id, node.family]));
  const edges: EdgeDetail[] = [];
  for (const row of rows) {
    const from = row.parentId ?? row.sessionId;
    if (!families.has(from)) continue;
    const fromFamily = families.get(from);
    const toFamily = families.get(row.id);
    edges.push({ id: `${from}->${row.id}`, from, to: row.id, kind: "delegate", label: row.title,
      ...(fromFamily ? { fromFamily } : {}), ...(toFamily ? { toFamily } : {}) });
    if (!RETURNED_STATUSES.has(row.status)) continue;
    const output = outputOf(row, context);
    const label = output === undefined ? undefined : firstLine(output, RETURN_LABEL_LIMIT);
    edges.push({ id: `${row.id}->${from}#return`, from: row.id, to: from, kind: "return",
      ...(label ? { label } : {}), ...(toFamily ? { fromFamily: toFamily } : {}), ...(fromFamily ? { toFamily: fromFamily } : {}) });
  }
  const client = session.client === "claude" || session.client === "codex" || session.client === "planner" ? session.client : undefined;
  return {
    id: session.id, name: session.name, ...(client ? { client } : {}), status: session.status,
    ...(session.waitingReason ? { waitingReason: session.waitingReason } : {}),
    startedAt: session.startedAt, ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    ...(session.goal ? { goal: session.goal } : {}), ...(session.model ? { model: session.model } : {}),
    turns: listRecentTurns(store.db, session.id, TURN_LIMIT).map(turnView), nodes, edges,
  };
}

function prUrlOf(output: string): string | undefined {
  return output.match(/https?:\/\/\S+/)?.[0];
}

function graphView(graph: GraphRow, events: GraphEventRow[], delegations: DelegationRow[], context: DelegationContext): GraphView {
  const byTask = new Map<string, GraphEventRow[]>();
  for (const event of events) {
    if (event.taskId === undefined) continue;
    byTask.set(event.taskId, [...(byTask.get(event.taskId) ?? []), event]);
  }
  const nodes = graph.tasks.map((task): NodeDetail => {
    const node: NodeDetail = { id: task.id, kind: "task", title: task.title, role: task.role,
      status: taskStatus(task.state), attempts: task.attempts, dependsOn: task.dependsOn };
    const delegation = delegations.filter((row) => row.taskId === task.id && row.sessionId === graph.sessionId).at(-1);
    if (delegation) {
      Object.assign(node, delegationDetail(delegation, context));
      if (graph.sessionId) node.branch = `agent-graph/${graph.sessionId}-${graph.id}/${task.id}`;
    }
    for (const event of byTask.get(task.id) ?? []) {
      if (event.kind === "task.failed" && typeof event.payload.reason === "string") node.feedback = event.payload.reason;
      if (event.kind === "pr.created" && typeof event.payload.output === "string") {
        const url = prUrlOf(event.payload.output);
        if (url) node.prUrl = url;
      }
    }
    return node;
  });
  const integratedFiles = new Map<string, string[]>();
  for (const event of events) {
    if (event.kind === "task.integrated" && event.taskId !== undefined && Array.isArray(event.payload.files)) {
      integratedFiles.set(event.taskId, event.payload.files.map(String));
    }
  }
  const edges: EdgeDetail[] = [];
  for (const task of graph.tasks) {
    for (const dep of task.dependsOn) {
      const files = integratedFiles.get(dep) ?? [];
      const label = files.slice(0, DEPENDS_LABEL_FILES).join(", ") + (files.length > DEPENDS_LABEL_FILES ? "…" : "");
      edges.push({ id: `${dep}->${task.id}`, from: dep, to: task.id, kind: "depends", ...(label ? { label } : {}) });
    }
  }
  return { id: graph.id, ...(graph.sessionId ? { sessionId: graph.sessionId } : {}), goal: graph.goal, nodes, edges };
}

function windowLabel(window: string): string {
  if (window === "5h") return "5h";
  if (window === "7d") return "Week";
  const minutes = window.match(/^(\d+)m$/);
  if (!minutes) return window;
  const value = Number(minutes[1]);
  if (value === 300) return "5h";
  if (value === 10080) return "Week";
  if (value >= 1440) return `${value / 1440}d`;
  if (value >= 60) return `${value / 60}h`;
  return `${value}m`;
}

function windowMinutes(window: string): number {
  if (window === "5h") return 300;
  if (window === "7d") return 10080;
  const minutes = window.match(/^(\d+)m$/);
  return minutes ? Number(minutes[1]) : Number.MAX_SAFE_INTEGER;
}

// 利用枠。provider ごとの最新の記録を人が読める名前で並べる。
export function buildUsage(samples: UsageSample[]): Usage {
  const sorted = [...samples].sort((a, b) =>
    (PROVIDER_ORDER[a.provider] - PROVIDER_ORDER[b.provider])
    || (Number(a.model !== undefined) - Number(b.model !== undefined))
    || (windowMinutes(a.window) - windowMinutes(b.window))
    || (a.model ?? "").localeCompare(b.model ?? ""));
  const windows: UsageWindow[] = sorted.map((sample) => ({
    key: `${sample.provider}:${sample.window}${sample.model ? `:${sample.model}` : ""}`,
    label: `${PROVIDER_LABELS[sample.provider]} ${windowLabel(sample.window)}${sample.model ? ` ${sample.model}` : ""}`,
    provider: sample.provider, percent: Math.round(sample.percent),
    ...(sample.resetsAt ? { resetsAt: sample.resetsAt } : {}),
  }));
  const ts = samples.map((sample) => sample.ts).sort().at(-1);
  return { ...(ts ? { ts } : {}), windows };
}

function mergeLatest(samples: UsageSample[]): UsageSample[] {
  const latest = new Map<string, UsageSample>();
  for (const sample of samples) {
    const key = `${sample.provider}\0${sample.model ?? ""}\0${sample.window}`;
    const previous = latest.get(key);
    if (!previous || sample.ts > previous.ts) latest.set(key, sample);
  }
  return [...latest.values()];
}

function countStatus(counts: ProjectSummary["counts"], status: Status): void {
  if (status === "running") counts.running++;
  else if (WAITING_STATUSES.has(status)) counts.waiting++;
  else if (FAILED_STATUSES.has(status)) counts.failed++;
  else if (status === "done") counts.done++;
}

// 一覧の 1 行。数えるのは生きたセッションの委譲とそのセッションの planner のタスク。
export function summarize(view: ProjectView, lastActivity: string | undefined, now: Date): ProjectSummary {
  const counts = { running: 0, waiting: 0, failed: 0, done: 0 };
  const live = view.sessions.filter((session) => session.status !== "ended");
  const liveIds = new Set(live.map((session) => session.id));
  for (const session of live) {
    if (session.status === "waiting") counts.waiting++;
    for (const node of session.nodes) if (node.kind !== "root") countStatus(counts, node.status);
  }
  for (const graph of view.graphs) {
    if (graph.sessionId === undefined || !liveIds.has(graph.sessionId)) continue;
    for (const node of graph.nodes) countStatus(counts, node.status);
  }
  const quiet = live.length === 0
    && (lastActivity === undefined || now.getTime() - Date.parse(lastActivity) > QUIET_AFTER_MS);
  const status: ProjectSummary["status"] = counts.waiting ? "waiting" : counts.failed ? "failed"
    : counts.running ? "running" : counts.done ? "done" : quiet ? "quiet" : "idle";
  return { key: view.project.key, name: view.project.name, rootPath: view.project.rootPath, counts,
    liveSessions: live.length, ...(lastActivity ? { lastActivityAt: lastActivity } : {}), status };
}

// 1 リポジトリの全体。repo が無ければ undefined。
export function buildProjectView(store: Store, repoKey: string, now = new Date()): ProjectView | undefined {
  const repo = getRepo(store.db, repoKey);
  if (!repo) return undefined;
  const delegations = listDelegations(store.db, repoKey);
  const graphs = listGraphs(store.db, repoKey);
  const context: DelegationContext = { byId: new Map(delegations.map((row) => [row.id, row])), outputs: new Map() };
  const graphEvents = new Map(graphs.map((graph) => [graph.id, listGraphEvents(store.db, graph.id)]));
  for (const events of graphEvents.values()) {
    for (const event of events) {
      if (event.kind === "task.result" && typeof event.payload.delegationId === "string" && typeof event.payload.output === "string") {
        context.outputs.set(event.payload.delegationId, event.payload.output);
      }
    }
  }
  const bySession = new Map<string, DelegationRow[]>();
  for (const row of delegations) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
  return {
    project: { key: repo.key, name: repo.name, rootPath: repo.rootPath },
    sessions: listSessions(store.db, repoKey).map((session) => sessionView(store, session, bySession.get(session.id) ?? [], context)),
    graphs: graphs.map((graph) => graphView(graph, graphEvents.get(graph.id) ?? [], delegations, context)),
    usage: buildUsage(latestUsageSamples(store.db)),
    updatedAt: now.toISOString(),
  };
}

// 全リポジトリの一覧。利用枠は store をまたいで最新のものを選ぶ。
export function buildOverview(stores: Map<string, Store>, now = new Date()): Overview {
  const projects: ProjectSummary[] = [];
  const samples: UsageSample[] = [];
  const seen = new Set<string>();
  for (const store of stores.values()) {
    for (const repo of listRepos(store.db)) {
      if (seen.has(repo.key)) continue;
      seen.add(repo.key);
      const view = buildProjectView(store, repo.key, now);
      if (view) projects.push(summarize(view, lastActivityAt(store.db, repo.key), now));
    }
    samples.push(...latestUsageSamples(store.db));
  }
  projects.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return { projects, usage: buildUsage(mergeLatest(samples)), updatedAt: now.toISOString() };
}
