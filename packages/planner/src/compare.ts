import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "../../core/src/store/store.ts";

export type CompareTask = { state: string; attempts: number; executor: string; model: string };
export type CompareRun = { session: string; branch: string; tasks: Record<string, CompareTask> };
export type CompareDifference = { kind: "task" | "state" | "attempts" | "file" | "branch"; id: string; legacy?: string | number; planner?: string | number };
export type CompareResult = { equal: boolean; differences: CompareDifference[]; models: { task: string; legacy: string; planner: string; legacyExecutor: string; plannerExecutor: string }[]; files: { legacy: string[]; planner: string[] } };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid legacy state object");
  return value as Record<string, unknown>;
}

export function loadLegacyState(path: string): CompareRun {
  const state = object(JSON.parse(readFileSync(path, "utf8")));
  const session = basename(path, ".json");
  const tasks: Record<string, CompareTask> = {};
  for (const [id, value] of Object.entries(state)) {
    if (id === "_meta") continue;
    const row = object(value);
    tasks[id] = { state: String(row.state ?? "planned"), attempts: Number(row.attempts ?? 0),
      executor: String(row.executor ?? ""), model: String(row.model ?? "") };
  }
  return { session, branch: `agent/${session}/integration`, tasks };
}

export function loadPlannerState(db: DatabaseSync | Store, selector: { graphId?: string; session?: string }): CompareRun {
  if (Boolean(selector.graphId) === Boolean(selector.session)) throw new Error("Specify exactly one of graphId or session");
  const database = db instanceof DatabaseSync ? db : db.db;
  const graph = selector.graphId
    ? database.prepare("SELECT id, session_id FROM graphs WHERE id = ?").get(selector.graphId)
    : database.prepare("SELECT id, session_id FROM graphs WHERE session_id = ? ORDER BY rowid DESC LIMIT 1").get(selector.session);
  if (!graph) throw new Error("Planner graph not found");
  const graphId = String(graph.id);
  const session = String(graph.session_id);
  const rows = database.prepare(`SELECT t.id, t.state, t.attempts, a.executor, a.model
    FROM tasks t LEFT JOIN delegations d ON d.id = (
      SELECT d2.id FROM delegations d2 WHERE d2.task_id = t.id AND d2.session_id = ?
        AND d2.repo_key = (SELECT repo_key FROM graphs WHERE id = ?)
      ORDER BY d2.rowid DESC LIMIT 1
    ) LEFT JOIN assignments a ON a.delegation_id = d.id
    WHERE t.graph_id = ? ORDER BY t.id`).all(session, graphId, graphId);
  const tasks: Record<string, CompareTask> = {};
  for (const row of rows) tasks[String(row.id)] = { state: String(row.state), attempts: Number(row.attempts),
    executor: String(row.executor ?? ""), model: String(row.model ?? "") };
  return { session, branch: `agent-graph/${session}-${graphId}/integration`, tasks };
}

function branchFiles(repo: string, branch: string): string[] | undefined {
  try {
    const output = execFileSync("git", ["ls-tree", "-r", "--name-only", `refs/heads/${branch}`],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.split("\n").filter(Boolean).sort();
  } catch {
    return undefined;
  }
}

export function compareRuns(legacy: CompareRun, planner: CompareRun, options: { repo: string }): CompareResult {
  const differences: CompareDifference[] = [];
  const models: CompareResult["models"] = [];
  for (const id of [...new Set([...Object.keys(legacy.tasks), ...Object.keys(planner.tasks)])].sort()) {
    const old = legacy.tasks[id];
    const current = planner.tasks[id];
    if (!old || !current) {
      differences.push({ kind: "task", id, legacy: old ? "present" : "missing", planner: current ? "present" : "missing" });
      continue;
    }
    if (old.state !== current.state) differences.push({ kind: "state", id, legacy: old.state, planner: current.state });
    if (old.attempts !== current.attempts) differences.push({ kind: "attempts", id, legacy: old.attempts, planner: current.attempts });
    models.push({ task: id, legacy: old.model, planner: current.model, legacyExecutor: old.executor, plannerExecutor: current.executor });
  }
  const legacyFiles = branchFiles(options.repo, legacy.branch);
  const plannerFiles = branchFiles(options.repo, planner.branch);
  if (!legacyFiles) differences.push({ kind: "branch", id: legacy.branch, legacy: "missing" });
  if (!plannerFiles) differences.push({ kind: "branch", id: planner.branch, planner: "missing" });
  const oldFiles = legacyFiles ?? [];
  const currentFiles = plannerFiles ?? [];
  if (legacyFiles && plannerFiles) {
    for (const file of oldFiles.filter((file) => !currentFiles.includes(file))) differences.push({ kind: "file", id: file, legacy: "present", planner: "missing" });
    for (const file of currentFiles.filter((file) => !oldFiles.includes(file))) differences.push({ kind: "file", id: file, legacy: "missing", planner: "present" });
  }
  return { equal: differences.length === 0, differences, models, files: { legacy: oldFiles, planner: currentFiles } };
}
