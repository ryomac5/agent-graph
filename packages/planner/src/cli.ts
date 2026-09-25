#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { compareRuns, loadLegacyState, loadPlannerState } from "./compare.ts";
import { openPlanner, requestDecision, runGraph, type RunOptions } from "./run.ts";
import { loadSpec, validateSpec } from "./spec.ts";

const EXAMPLE_TASKS = `# タスクグラフの雛形。agent-graph-plan validate --session <識別子> で検証する
goal: |
  ここに達成したいゴールを書く。
# base_branch: main
tasks:
  - id: T1
    title: 実装タスクの例
    executor: codex
    scope: ["src/**"]
    outputs: ["src/example.ts"]
    accept:
      - "node --test"
    prompt: |
      何を実装するかをここに書く。
  - id: D1
    title: 文書タスクの例
    executor: doc-light
    scope: ["docs/agents/**"]
    outputs: ["docs/agents/example.md"]
    accept:
      - "test -s docs/agents/example.md"
    prompt: |
      何を書くかをここに書く。
  - id: G1
    title: 統合結果の最終確認
    executor: human
    depends_on: [T1, D1]
    prompt: |
      統合ブランチの差分とレポートを確認する。
  - id: PR
    title: PR を作成
    executor: pr
    depends_on: [G1]
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    session: { type: "string" }, spec: { type: "string" }, "max-parallel": { type: "string" }, "no-pr": { type: "boolean" },
    "legacy-state": { type: "string" }, graph: { type: "string" }, json: { type: "boolean" },
  } });
  const [command, task] = positionals;
  if (command === "init" || command === "validate") {
    if (!values.session || !/^[A-Za-z0-9_-]+$/.test(values.session) || positionals.length !== 1)
      throw new Error(`Usage: agent-graph-plan ${command} --session <id> [--spec path]`);
    const path = values.spec ? resolve(values.spec) : join(process.cwd(), ".agents", "graph", values.session, "tasks.yaml");
    if (command === "init") {
      if (existsSync(path)) throw new Error(`既にあります: ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, EXAMPLE_TASKS, { flag: "wx" });
      console.log(`雛形を置きました: ${path}`);
    } else {
      const errors = validateSpec(loadSpec(path));
      if (errors.length) throw new Error(`NG:\n- ${errors.join("\n- ")}`);
      console.log(`OK: ${values.session} の tasks.yaml は有効です`);
    }
  } else if (command === "compare") {
    if (positionals.length !== 1 || !values["legacy-state"] || (values.graph && values.session))
      throw new Error("Usage: agent-graph-plan compare --legacy-state <path> [--graph <id> | --session <id>] [--json]");
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    const db = new DatabaseSync(stateDbPath(repoKey(root)), { readOnly: true });
    try {
      const legacy = loadLegacyState(values["legacy-state"]);
      const planner = loadPlannerState(db, { graphId: values.graph, session: values.session ?? (values.graph ? undefined : legacy.session) });
      const result = compareRuns(legacy, planner, { repo: root });
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`比較: ${legacy.session} / ${planner.session} (${result.equal ? "一致" : "差分あり"})`);
        console.log("種別\t対象\t旧版\t新版");
        for (const row of result.differences) console.log(`${row.kind}\t${row.id}\t${row.legacy ?? ""}\t${row.planner ?? ""}`);
        console.log("モデル情報: タスク\t旧版 executor/model\t新版 executor/model");
        for (const row of result.models) console.log(`${row.task}\t${row.legacyExecutor}/${row.legacy}\t${row.plannerExecutor}/${row.planner}`);
      }
      if (!result.equal) process.exitCode = 1;
    } finally { db.close(); }
  } else {
    if (!values.session || !["run", "status", "approve", "reject", "retry"].includes(command ?? "") || positionals.length > (["approve", "reject", "retry"].includes(command!) ? 2 : 1)) {
      throw new Error("Usage: agent-graph-plan run|status|approve|reject|retry [task] --session <id> [--spec path] [--max-parallel n] [--no-pr]");
    }
    const options: RunOptions = { repo: process.cwd(), session: values.session, specPath: values.spec,
      maxParallel: values["max-parallel"] === undefined ? undefined : Number(values["max-parallel"]), noPr: values["no-pr"] };
    if (command === "run") {
      const result = await runGraph(options);
      console.log(JSON.stringify(result, null, 2));
      if (result.tasks.some((task) => task.state !== "done")) process.exitCode = 1;
    } else if (command === "status") {
      const context = openPlanner(options.repo, options.session, options.specPath);
      try {
        const graph = context.store.findGraph(context.key, options.session, context.fingerprint);
        if (!graph) throw new Error("Graph not found; run it first");
        console.log(JSON.stringify({ graph, tasks: context.store.listTasks(graph.id) }, null, 2));
      } finally { context.store.close(); }
    } else {
      if (!task) throw new Error("Task id is required");
      requestDecision(options, task, command as "approve" | "reject" | "retry");
      console.log(`${task}: ${command}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
