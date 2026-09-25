import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphSpec, TaskSpec } from "../src/spec.ts";
import { renderReport } from "../src/report.ts";

test("タスク表と各タスクの報告を Markdown にする", () => {
  const graph = { goal: "目的", base_branch: "main", tasks: [{ id: "T1", title: "作業", executor: "codex" } as TaskSpec] } satisfies GraphSpec;
  const report = renderReport(graph, { T1: { state: "done", attempts: 2, verify: { passed: true }, output: "実施内容" } });
  assert.match(report, /\| T1 作業 \| codex \| done \| 2 \| 合格 \|/);
  assert.match(report, /## 各タスクの報告\n### T1 作業\n\n実施内容/);
});

test("CLI init は雛形を作り、validate は既存の検証を実行する", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "planner-init-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const cli = join(import.meta.dirname, "../src/cli.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args, "--session", "sample"], { cwd: repo, encoding: "utf8" });
  assert.match(run("init"), /雛形を置きました/);
  const path = join(repo, ".agents/graph/sample/tasks.yaml");
  assert.match(readFileSync(path, "utf8"), /depends_on: \[G1\]/);
  assert.match(run("validate"), /有効です/);
  assert.equal(spawnSync(process.execPath, [cli, "init", "--session", "sample"], { cwd: repo }).status, 1);
  writeFileSync(path, "tasks: []\n");
  assert.equal(spawnSync(process.execPath, [cli, "validate", "--session", "sample"], { cwd: repo }).status, 1);
});
