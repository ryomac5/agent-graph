import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseYaml } from "./yaml.ts";

export type TaskSpec = {
  id: string;
  title: string;
  executor: string;
  depends_on: string[];
  scope: string[];
  inputs: string[];
  outputs: string[];
  accept: string[];
  prompt: string;
  review: boolean;
  model: string;
  model_reason: string;
  review_model: string;
  retry: { max: number; escalate_to: string };
  timeout_sec: number;
};
export type GraphSpec = { goal: string; base_branch: string; tasks: TaskSpec[] };

const EXECUTORS = ["codex", "doc-light", "doc-heavy", "human", "pr"];
export function roleForExecutor(executor: string): "implement" | "document" | "human" | "pr" {
  if (executor === "codex") return "implement";
  if (executor === "doc-light" || executor === "doc-heavy") return "document";
  if (executor === "human" || executor === "pr") return executor;
  throw new Error(`unknown executor: ${executor}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error("tasks.yaml: expected map");
}
function strings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("tasks.yaml: expected sequence");
  return value.map(String);
}
function normalizeTask(value: unknown): TaskSpec {
  const raw = record(value);
  const executor = String(raw.executor ?? "codex");
  const retry = record(raw.retry ?? {});
  return {
    id: String(raw.id ?? ""), title: String(raw.title ?? ""), executor,
    depends_on: strings(raw.depends_on), scope: strings(raw.scope),
    inputs: strings(raw.inputs), outputs: strings(raw.outputs), accept: strings(raw.accept),
    prompt: String(raw.prompt ?? ""), review: Boolean(raw.review ?? (executor === "codex")),
    model: String(raw.model ?? ""), model_reason: String(raw.model_reason ?? ""),
    review_model: String(raw.review_model ?? ""),
    retry: { max: Number(retry.max ?? 1), escalate_to: String(retry.escalate_to ?? "human") },
    timeout_sec: Number(raw.timeout_sec ?? 1800),
  };
}
export function loadSpec(path: string): GraphSpec {
  const raw = record(parseYaml(readFileSync(path, "utf8")) ?? {});
  return {
    goal: String(raw.goal ?? ""), base_branch: String(raw.base_branch ?? ""),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map(normalizeTask),
  };
}

export function validateSpec(spec: GraphSpec): string[] {
  const errors: string[] = [];
  if (!spec.tasks.length) errors.push("tasks が空です");
  const byId = new Map(spec.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  for (const task of spec.tasks) {
    const id = task.id;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) errors.push(`${JSON.stringify(id)}: id は英数字・-・_ のみ`);
    if (seen.has(id)) errors.push(`${id}: id が重複`);
    seen.add(id);
    if (!EXECUTORS.includes(task.executor)) errors.push(`${id}: executor ${JSON.stringify(task.executor)} は未定義（${EXECUTORS.join(", ")}）`);
    if (!task.title) errors.push(`${id}: title が必要（辺ラベルになる）`);
    for (const dep of task.depends_on) {
      if (!byId.has(dep)) errors.push(`${id}: depends_on の ${dep} が存在しない`);
      if (dep === id) errors.push(`${id}: 自分自身に依存している`);
    }
    if (["codex", "doc-light", "doc-heavy"].includes(task.executor)) {
      if (!task.accept.length) errors.push(`${id}: accept（受け入れコマンド）が必要。機械検証できない委譲は禁止`);
      if (!task.prompt.trim()) errors.push(`${id}: prompt が空`);
    }
    if (task.executor === "codex" && !task.scope.length) errors.push(`${id}: codex タスクには scope（触ってよいファイル）が必要`);
    if (!EXECUTORS.includes(task.retry.escalate_to)) errors.push(`${id}: retry.escalate_to ${JSON.stringify(task.retry.escalate_to)} は未定義`);
  }
  const active = new Set<string>();
  const done = new Set<string>();
  let cycle: string[] = [];
  const visit = (id: string, path: string[]): void => {
    if (cycle.length || done.has(id)) return;
    if (active.has(id)) { cycle = path.slice(path.indexOf(id)); return; }
    active.add(id);
    for (const dep of byId.get(id)?.depends_on ?? []) if (byId.has(dep)) visit(dep, [...path, dep]);
    active.delete(id);
    done.add(id);
  };
  for (const id of byId.keys()) visit(id, [id]);
  if (cycle.length) errors.push(`依存が循環しています: ${cycle.join(" → ")}`);
  const ancestors = (id: string): Set<string> => {
    const result = new Set<string>();
    const pending = [...(byId.get(id)?.depends_on ?? [])];
    while (pending.length) {
      const next = pending.pop()!;
      if (result.has(next) || !byId.has(next)) continue;
      result.add(next);
      pending.push(...byId.get(next)!.depends_on);
    }
    return result;
  };
  const prTasks = spec.tasks.filter((task) => task.executor === "pr");
  if (prTasks.length > 1) errors.push("pr タスクは 1 つまで");
  for (const pr of prTasks) {
    const upstream = ancestors(pr.id);
    if (spec.tasks.some((task) => task.id !== pr.id && !upstream.has(task.id))) errors.push(`${pr.id}: pr タスクは他の全タスクの下流（最終ノード）に置く`);
    if (![...upstream].some((id) => byId.get(id)?.executor === "human")) errors.push(`${pr.id}: pr タスクの上流に executor: human の承認ゲートが必要`);
  }
  return errors;
}

export function graphFingerprint(spec: GraphSpec): string {
  const body = [spec.goal.trim(), ...spec.tasks.map((task) => `${task.id}:${roleForExecutor(task.executor)}`).sort()].join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}
