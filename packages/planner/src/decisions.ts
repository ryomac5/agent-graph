import { decisionAllowed, type GraphRecord, type Store, type TaskDecision, type TaskDecisionRow } from "../../core/src/index.ts";

// 判断の読み書き。CLI とダッシュボードは task_decisions 表に書き、planner がここで拾う。
export const DECISION_POLL_MS = 1000;
const APPLIED_EVENT = "decision.applied";

export function isDecision(value: string): value is TaskDecision {
  return value === "approve" || value === "reject" || value === "retry";
}

// 対象の状態を検べて記録する。合わなければ例外。
export function recordDecision(store: Store, graph: GraphRecord, taskId: string, decision: TaskDecision, now = new Date()): void {
  const task = store.getTask(graph.id, taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!decisionAllowed(task.state, decision)) throw new Error(`${taskId} is not waiting (state: ${task.state})`);
  store.insertTaskDecision(graph.id, taskId, decision, now.toISOString());
}

// まだ適用していない判断を記録順に返す。
export function pendingDecisions(store: Store, graph: GraphRecord): TaskDecisionRow[] {
  const applied = new Set(store.listGraphEvents(graph.id, APPLIED_EVENT).map((event) => Number(event.payload.decisionId)));
  return store.listTaskDecisions(graph.id).filter((decision) => !applied.has(decision.id));
}

export function markApplied(store: Store, graph: GraphRecord, decision: TaskDecisionRow, effect: string): void {
  store.appendGraphEvent(graph, APPLIED_EVENT, { decisionId: decision.id, taskId: decision.taskId, decision: decision.action, effect });
}
