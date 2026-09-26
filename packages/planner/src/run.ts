import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, matchesGlob, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decisionAllowed, newTraceId, openStore, repoKey, stateDbPath, ulid, type GraphRecord, type Store, type TaskRecord } from "../../core/src/index.ts";
import { isDecision, markApplied, pendingDecisions, recordDecision, DECISION_POLL_MS } from "./decisions.ts";
import { connectDelegate } from "./mcp-client.ts";
import { buildTaskPrompt } from "./prompt.ts";
import { renderReport, type TaskReport } from "./report.ts";
import { nextAttempt } from "./retry.ts";
import { graphFingerprint, loadSpec, roleForExecutor, validateSpec, type TaskSpec } from "./spec.ts";
import { commitScoped, createTaskWorktree, mergeIntoIntegration, prepareIntegration } from "./worktree.ts";

// 実行結果を TaskReport に寄せて、PR 本文と report.md に使う。
function buildResults(store: Store, graph: GraphRecord, tasks: TaskSpec[]): Record<string, TaskReport> {
  const results: Record<string, TaskReport> = {};
  for (const task of tasks) {
    const row = store.getTask(graph.id, task.id);
    const outcome = store.listGraphEvents(graph.id, "task.result")
      .filter((event) => event.payload.taskId === task.id)
      .at(-1);
    results[task.id] = {
      executor: row?.role,
      state: row?.state,
      attempts: row?.attempts,
      output: outcome ? JSON.stringify(outcome.payload) : undefined,
    };
  }
  return results;
}

function runDir(root: string): string {
  const key = repoKey(root);
  return dirname(stateDbPath(key));
}

// 失敗を nextAttempt で判断する。再試行なら planned に戻してループで拾う。
function applyRetry(store: Store, graph: GraphRecord, task: TaskSpec, current: TaskRecord): void {
  const next = nextAttempt(task, { attempts: current.attempts + 1, executor: task.executor, model: task.model });
  store.updateTask(graph.id, task.id, next.state, next.attempts);
}

const POLL_MS = 200;
const ACTIVE_STATES = new Set(["running", "verifying", "reviewing", "merging"]);
const WAITING_STATES = new Set(["waiting_human", "conflict"]);
export type RunOptions = { repo: string; session: string; specPath?: string; maxParallel?: number; noPr?: boolean };

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function openPlanner(repo: string, session: string, specPath?: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("session must contain only letters, digits, - and _");
  const root = git(repo, "rev-parse", "--show-toplevel");
  const path = specPath ? resolve(repo, specPath) : join(root, ".agents", "graph", session, "tasks.yaml");
  const spec = loadSpec(path);
  const errors = validateSpec(spec);
  if (errors.length) throw new Error(errors.join("\n"));
  const key = repoKey(root);
  const store = openStore(stateDbPath(key));
  return { root, spec, store, key, session, fingerprint: graphFingerprint(spec) };
}

export function worktreeSession(graph: GraphRecord): string { return `${graph.sessionId}-${graph.id}`; }

function integrateTask(repo: string, store: Store, graph: GraphRecord, task: TaskSpec): void {
  store.updateTask(graph.id, task.id, "merging");
  const namespace = worktreeSession(graph);
  const worktree = createTaskWorktree(repo, namespace, task.id);
  const patterns = [...task.scope, ...task.outputs];
  const excluded = commitScoped(worktree, `agent(${task.id}): ${task.title}`, patterns.length ? patterns : ["**"]);
  const committed = git(worktree, "diff", "--name-only", `agent-graph/${namespace}/integration...HEAD`).split("\n").filter(Boolean);
  const outsideCommits = committed.filter((path) => patterns.length && !patterns.some((pattern) => matchesGlob(path, pattern)));
  if (outsideCommits.length) {
    store.updateTask(graph.id, task.id, "failed");
    store.appendGraphEvent(graph, "task.failed", { taskId: task.id, reason: "統合範囲外のコミット", files: outsideCommits });
    return;
  }
  if (excluded.length && !committed.some((path) => !patterns.length || patterns.some((pattern) => matchesGlob(path, pattern)))) {
    store.updateTask(graph.id, task.id, "failed");
    store.appendGraphEvent(graph, "task.failed", { taskId: task.id, reason: "統合対象なし", excluded });
    return;
  }
  const result = mergeIntoIntegration(repo, namespace, task.id);
  store.updateTask(graph.id, task.id, result.conflict ? "conflict" : "done");
  store.appendGraphEvent(graph, "task.integrated", { taskId: task.id, ...result, excluded });
}

export function requestDecision(options: RunOptions, taskId: string, decision: "approve" | "reject" | "retry"): void {
  const context = openPlanner(options.repo, options.session, options.specPath);
  const { store } = context;
  try {
    const graph = store.findGraph(context.key, options.session, context.fingerprint);
    if (!graph) throw new Error("Graph not found; run it first");
    recordDecision(store, graph, taskId, decision);
  } finally { store.close(); }
}

// task_decisions の未適用分を状態に反映する。approve は統合、retry は再実行、reject は却下。
function applyDecisions(repo: string, store: Store, graph: GraphRecord, tasks: TaskSpec[]): void {
  for (const decision of pendingDecisions(store, graph)) {
    const task = tasks.find((task) => task.id === decision.taskId);
    const current = task && store.getTask(graph.id, task.id);
    let effect = "skipped";
    if (task && current && isDecision(decision.action) && decisionAllowed(current.state, decision.action)) {
      effect = "applied";
      if (decision.action === "retry") store.updateTask(graph.id, task.id, "planned", current.state === "failed" ? current.attempts : 0);
      else if (decision.action === "reject") store.updateTask(graph.id, task.id, "rejected");
      else if (task.executor === "human") store.updateTask(graph.id, task.id, "done");
      else integrateTask(repo, store, graph, task);
    }
    markApplied(store, graph, decision, effect);
  }
}

function claimRun(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid planner lock");
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      unlinkSync(path);
    }
  }
  const fd = openSync(path, "wx");
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => unlinkSync(path);
}

export async function runGraph(options: RunOptions, dependencies: { connect?: typeof connectDelegate } = {}): Promise<{ graph: GraphRecord; tasks: TaskRecord[]; integration: string }> {
  const maxParallel = options.maxParallel ?? 3;
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) throw new Error("maxParallel must be a positive integer");
  const { root, spec, store, key, fingerprint } = openPlanner(options.repo, options.session, options.specPath);
  let release: (() => void) | undefined;
  let client: Awaited<ReturnType<typeof connectDelegate>> | undefined;
  let connection: ReturnType<typeof connectDelegate> | undefined;
  const active = new Map<string, Promise<void>>();
  try {
    release = claimRun(join(dirname(stateDbPath(key)), `planner-${options.session}.lock`));
    store.upsertRepo({ key, rootPath: root, name: basename(root) });
    if (!store.db.prepare("SELECT id FROM sessions WHERE id = ?").get(options.session)) {
      store.insertSession({ id: options.session, repoKey: key, name: options.session, client: "planner", traceId: newTraceId(), startedAt: new Date().toISOString() });
    }
    store.updateSessionClient(options.session, "planner");
    let graph = store.findGraph(key, options.session, fingerprint);
    if (!graph) {
      graph = { id: ulid(), repoKey: key, sessionId: options.session, goal: spec.goal, fingerprint, createdAt: new Date().toISOString() };
      store.insertGraph(graph, spec.tasks.map((task) => ({ graphId: graph!.id, id: task.id, title: task.title,
        role: roleForExecutor(task.executor), dependsOn: task.depends_on, state: "planned", attempts: 0 })));
    }
    const currentGraph = graph;
    const namespace = worktreeSession(graph);
    const initialized = store.listGraphEvents(graph.id, "initialized")[0];
    const base = initialized ? String(initialized.payload.baseBranch)
      : spec.base_branch || git(root, "symbolic-ref", "--short", "HEAD");
    if (!initialized) store.appendGraphEvent(graph, "initialized", { baseBranch: base });
    const integration = prepareIntegration(root, namespace, base);
    for (const task of store.listTasks(graph.id)) {
      if (ACTIVE_STATES.has(task.state)) store.updateTask(graph.id, task.id, "planned");
    }
    const executeTask = async (task: TaskSpec, current: TaskRecord): Promise<void> => {
      try {
        if (task.executor === "human") { store.updateTask(currentGraph.id, task.id, "waiting_human"); return; }
        if (task.executor === "pr" && options.noPr) {
          store.updateTask(currentGraph.id, task.id, "done");
          store.appendGraphEvent(currentGraph, "pr.skipped", { taskId: task.id, reason: "--no-pr" });
          return;
        }
        store.updateTask(currentGraph.id, task.id, "running", current.attempts + 1);
        if (task.executor === "pr") {
          const results = buildResults(store, currentGraph, spec.tasks);
          const body = renderReport({ ...spec, session: options.session }, results);
          const dir = runDir(root);
          writeFileSync(join(dir, "report.md"), body);
          const head = git(integration, "branch", "--show-current");
          git(integration, "push", "-u", "origin", head);
          const output = execFileSync("gh", ["pr", "create", "--base", base, "--head", head, "--title",
            `[agent ${options.session}] ${spec.goal.trim().split("\n")[0] || task.title}`, "--body", body], { cwd: root, encoding: "utf8" });
          store.appendGraphEvent(currentGraph, "pr.created", { taskId: task.id, output, report: join(dir, "report.md") });
          store.updateTask(currentGraph.id, task.id, "done");
          return;
        }
        const role = roleForExecutor(task.executor);
        if (role !== "implement" && role !== "document") throw new Error(`Invalid delegate role: ${role}`);
        const cwd = createTaskWorktree(root, namespace, task.id);
        if (task.model || task.review_model) store.appendGraphEvent(currentGraph, "model.ignored", {
          taskId: task.id, model: task.model, review_model: task.review_model, reason: "割り当ては daemon が決める",
        });
        // hello は元リポジトリから送り、delegate の cwd だけを worktree にする。
        connection ??= (dependencies.connect ?? connectDelegate)({ cwd: root,
          env: { AGENT_GRAPH_SESSION: options.session, TRACEPARENT: "", TRACESTATE: "", AGENT_GRAPH_DELEGATION: "" } });
        client = await connection;
        const upstream = spec.tasks.filter((source) => task.depends_on.includes(source.id));
        const prompt = buildTaskPrompt({ goal: spec.goal, task, upstream });
        const result = await client.delegate({ role, title: task.title, task: prompt, accept: task.accept,
          scope: task.scope, outputs: task.outputs, review: task.review, timeoutSec: task.timeout_sec, cwd });
        store.appendGraphEvent(currentGraph, "task.result", { taskId: task.id, ...result });
        store.db.prepare("UPDATE delegations SET task_id = ? WHERE id = ?").run(task.id, result.delegationId);
        if (result.status === "done") integrateTask(root, store, currentGraph, task);
        else applyRetry(store, currentGraph, task, current);
      } catch (error) {
        store.appendGraphEvent(currentGraph, "task.failed", { taskId: task.id, reason: String(error) });
        applyRetry(store, currentGraph, task, current);
      }
    };
    // 判断待ちの表は 1 秒ごとに見る。起動直後は待たずに拾う。
    let decisionsCheckedAt = 0;
    for (;;) {
      if (Date.now() - decisionsCheckedAt >= DECISION_POLL_MS) {
        applyDecisions(root, store, graph, spec.tasks);
        decisionsCheckedAt = Date.now();
      }
      const rows = store.listTasks(graph.id);
      const states = new Map(rows.map((task) => [task.id, task.state]));
      for (const task of spec.tasks) {
        if (active.size >= maxParallel) break;
        if (states.get(task.id) !== "planned" || active.has(task.id) || !task.depends_on.every((id) => states.get(id) === "done")) continue;
        const promise = executeTask(task, rows.find((row) => row.id === task.id)!).finally(() => active.delete(task.id));
        active.set(task.id, promise);
      }
      if (!active.size && !store.listTasks(graph.id).some((row) => WAITING_STATES.has(row.state))) break;
      await delay(POLL_MS);
    }
    return { graph, tasks: store.listTasks(graph.id), integration };
  } finally {
    await Promise.allSettled(active.values());
    await client?.close(); release?.(); store.close();
  }
}
