import { decisionAllowed, type GraphRecord, type Store, type TaskDecision } from "../../core/src/store/store.ts";
import type { ActionRequest, ActionResult } from "./http/contract.ts";
import { NotFoundError } from "./sessions.ts";

// 識別子は英数字と . - _ だけ。repo の key は <名前>-<hash>、task は spec の規則、session と turn は uuid か ulid。
const IDENT = /^[A-Za-z0-9._-]{1,128}$/;
const ACTIONS = new Set<ActionRequest["action"]>(["approve", "retry", "reject", "end_session", "hide_turn"]);
const DECISIONS = new Set<TaskDecision>(["approve", "retry", "reject"]);

function ident(value: unknown, name: string): string {
  if (typeof value !== "string" || !IDENT.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

// body を検べて ActionRequest にする。不正なら TypeError。
export function parseAction(body: unknown): ActionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Invalid action body");
  const { action, repo, graphId, taskId, sessionId, turnId } = body as Record<string, unknown>;
  if (typeof action !== "string" || !ACTIONS.has(action as ActionRequest["action"])) throw new TypeError(`Unknown action: ${String(action)}`);
  const request: ActionRequest = { action: action as ActionRequest["action"], repo: ident(repo, "repo") };
  if (DECISIONS.has(action as TaskDecision)) {
    request.graphId = ident(graphId, "graphId");
    request.taskId = ident(taskId, "taskId");
  } else if (action === "end_session") {
    request.sessionId = ident(sessionId, "sessionId");
  } else {
    request.turnId = ident(turnId, "turnId");
  }
  return request;
}

// graphId は graphs.id を受ける。planner のセッション識別子でも引けるようにする。
function findGraph(store: Store, repo: string, graphId: string): GraphRecord | undefined {
  const graph = store.getGraph(graphId);
  if (graph && graph.repoKey === repo) return graph;
  return store.findGraph(repo, graphId);
}

function decide(store: Store, request: ActionRequest, now: Date): ActionResult {
  const graph = findGraph(store, request.repo, request.graphId!);
  if (!graph) throw new NotFoundError(`Graph not found: ${request.graphId}`);
  const task = store.getTask(graph.id, request.taskId!);
  if (!task) throw new NotFoundError(`Task not found: ${request.taskId}`);
  const action = request.action as TaskDecision;
  if (!decisionAllowed(task.state, action)) {
    return { ok: false, message: `${task.id} は操作できる状態ではない（現在: ${task.state}）` };
  }
  store.insertTaskDecision(graph.id, task.id, action, now.toISOString());
  const label = { approve: "承認", retry: "再試行", reject: "却下" }[action];
  return { ok: true, message: `${task.id} を${label}した。planner が反映する` };
}

function endSession(store: Store, request: ActionRequest, now: Date): ActionResult {
  const id = request.sessionId!;
  const session = store.getSession(id);
  if (!session || session.repoKey !== request.repo) throw new NotFoundError(`Session not found: ${id}`);
  if (session.status === "ended") return { ok: false, message: `${session.name} は終了済み` };
  store.endSession(id, now.toISOString());
  return { ok: true, message: `${session.name} を終了した` };
}

function hideTurn(store: Store, request: ActionRequest): ActionResult {
  const id = request.turnId!;
  const turn = store.getTurn(id);
  const session = turn && store.getSession(turn.sessionId);
  if (!turn || !session || session.repoKey !== request.repo) throw new NotFoundError(`Turn not found: ${id}`);
  if (turn.hidden) return { ok: false, message: `${id} は非表示済み` };
  store.setTurnHidden(id, true);
  return { ok: true, message: `${id} の履歴を非表示にした` };
}

// POST /api/action の本体。不正な body は TypeError、未知の対象は NotFoundError。
// 対象の状態が合わないときは ok: false で理由を返す。
export function performAction(body: unknown, stores: Map<string, Store>, now = new Date()): ActionResult {
  const request = parseAction(body);
  const store = stores.get(request.repo);
  if (!store) throw new NotFoundError(`Repo not found: ${request.repo}`);
  if (request.action === "end_session") return endSession(store, request, now);
  if (request.action === "hide_turn") return hideTurn(store, request);
  return decide(store, request, now);
}
