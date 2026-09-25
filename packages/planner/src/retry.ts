import type { TaskSpec } from "./spec.ts";

export type AttemptState = {
  attempts: number;
  executor?: string;
  model?: string;
  escalated?: boolean;
};

export function nextAttempt(task: TaskSpec, state: AttemptState): AttemptState & { state: "planned" | "waiting_human" } {
  const executor = state.executor || task.executor;
  const model = state.model ?? task.model;
  const max = task.retry?.max ?? 1;
  const escalateTo = task.retry?.escalate_to ?? "human";
  if (state.attempts <= max) return { ...state, executor, model, state: "planned" };
  if (escalateTo !== "human" && !state.escalated) {
    const family = (name: string): string => name === "doc-light" || name === "doc-heavy" ? "claude" : name;
    return { ...state, executor: escalateTo, model: family(executor) === family(escalateTo) ? model : "", escalated: true, state: "planned" };
  }
  return { ...state, executor, model, state: "waiting_human" };
}
