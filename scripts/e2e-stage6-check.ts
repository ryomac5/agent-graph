import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openPlanner, worktreeSession } from "../packages/planner/src/run.ts";

const [mode, repo, extra, phase] = process.argv.slice(2);
const SESSION = "stage6";
const OUTPUTS = ["a.txt", "b.txt", "notes.md"];
const TIMEOUT_MS = 20 * 60 * 1000;
function git(...args: string[]): string { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function readOld(): Record<string, { state: string; feedback?: string; note?: string }> {
  const path = join(repo, ".agents/state/graph/stage6.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}
function readNew() {
  const ctx = openPlanner(repo, SESSION);
  try {
    const graph = ctx.store.findGraph(ctx.key, SESSION, ctx.fingerprint);
    if (!graph) return undefined;
    return { graph, tasks: ctx.store.listTasks(graph.id),
      delegations: Number(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM delegations WHERE session_id = ?").get(SESSION)!.n),
      reviews: Number(ctx.store.db.prepare("SELECT COUNT(*) AS n FROM reviews r JOIN delegations d ON d.id = r.delegation_id WHERE d.session_id = ?").get(SESSION)!.n) };
  } finally { ctx.store.close(); }
}
if (mode === "fixture") {
  const path = join(repo, ".agents/graph/stage6"); mkdirSync(path, { recursive: true });
  const worker = (id: string, output: string, executor: string, deps: string[]) => `  - id: ${id}\n    title: ${id}\n    executor: ${executor}\n    model: ${executor === "codex" ? "gpt-6-luna" : "haiku"}\n    review_model: sonnet\n    depends_on: [${deps.join(", ")}]\n    scope: [${output}]\n    outputs: [${output}]\n    accept: ["test -f ${output}"]\n    prompt: "Create ${output} containing exactly the line ${id}. ${deps.length ? "Read a.txt first. " : ""}Do not change any other files. Do not commit or ask questions."\n`;
  const spec = "goal: stage6 fixture\nbase_branch: main\ntasks:\n" + worker("a", "a.txt", "codex", []) + worker("b", "b.txt", "codex", ["a"]) + worker("doc", "notes.md", "doc-light", []) +
    "  - id: gate\n    title: approve outputs\n    executor: human\n    depends_on: [b, doc]\n" +
    (extra === "full" ? "  - id: pr\n    title: publish\n    executor: pr\n    depends_on: [gate]\n" : "");
  writeFileSync(join(path, "tasks.yaml"), spec);
} else if (mode === "wait-new" || mode === "wait-old") {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const tasks = mode === "wait-new" ? readNew()?.tasks ?? [] : Object.entries(readOld()).filter(([id]) => id !== "_meta").map(([id, task]) => ({ ...task, id }));
    if (tasks.some((task) => ["failed", "rejected", "conflict"].includes(task.state))) throw new Error(`Task failed: ${JSON.stringify(tasks)}`);
    if (tasks.some((task) => task.id !== "gate" && task.state === "waiting_human")) {
      throw new Error(`Worker requires human intervention: ${JSON.stringify(tasks)}`);
    }
    if (phase === "complete" ? tasks.length > 0 && tasks.every((task) => task.state === "done")
      : tasks.some((task) => task.id === "gate" && task.state === "waiting_human")) break;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${phase === "complete" ? "completion" : "human gate"}: ${JSON.stringify(tasks)}`);
    try { process.kill(Number(extra), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      throw new Error(`Graph runner exited before ${phase === "complete" ? "completion" : "human gate"}: ${JSON.stringify(tasks)}; see runner and daemon logs`);
    }
    await delay(500);
  }
} else if (mode === "check-new") {
  const result = readNew(); assert.ok(result);
  assert.ok(result.tasks.every((task) => task.state === "done"), JSON.stringify(result.tasks));
  assert.ok(result.delegations >= 3); assert.ok(result.reviews >= 2);
  const branch = `agent-graph/${worktreeSession(result.graph)}/integration`;
  const files = git("ls-tree", "-r", "--name-only", branch).split("\n").sort();
  assert.deepEqual(files, OUTPUTS);
  console.log(JSON.stringify({ states: Object.fromEntries(result.tasks.map((task) => [task.id, task.state])), files }));
} else if (mode === "compare" || mode === "diagnose") {
  const expected = JSON.parse(readFileSync(extra, "utf8"));
  const states = Object.fromEntries(Object.entries(readOld()).filter(([id]) => id !== "_meta").map(([id, task]) => [id, task.state]));
  const branch = "agent/stage6/integration";
  const branchExists = Boolean(git("branch", "--list", branch));
  const files = branchExists ? git("ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort() : [];
  console.log("Task states (planner / legacy):");
  for (const id of [...new Set([...Object.keys(expected.states), ...Object.keys(states)])].sort()) {
    console.log(`  ${id}: ${expected.states[id] ?? "(missing)"} / ${states[id] ?? "(missing)"}`);
  }
  console.log(`Planner integration files: ${JSON.stringify(expected.files)}`);
  console.log(`Legacy integration files: ${JSON.stringify(files)}${branchExists ? "" : " (branch missing)"}`);
  console.log("Integration file diff (- planner only, + legacy only):");
  for (const file of expected.files) if (!files.includes(file)) console.log(`- ${file}`);
  for (const file of files) if (!expected.files.includes(file)) console.log(`+ ${file}`);
  if (mode === "compare") {
    assert.ok(branchExists, "Legacy integration branch is missing");
    assert.deepEqual(states, expected.states); assert.deepEqual(files, expected.files);
    console.log("PASS: legacy and planner task states and integration files match");
  }
} else throw new Error(`Unknown mode: ${mode}`);
