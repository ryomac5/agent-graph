import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSpec } from "../src/spec.ts";
import { buildTaskPrompt } from "../src/prompt.ts";

const task = (id: string, outputs: string[] = []): TaskSpec => ({ id, title: id, executor: "codex", depends_on: [], scope: ["src/**"], inputs: ["README.md"], outputs, accept: ["node --test"], prompt: "実装する", review: true, model: "", model_reason: "", review_model: "", retry: { max: 1, escalate_to: "human" }, timeout_sec: 1800 });

test("指示文に目的・上流の成果物・失敗理由・規則を含める", () => {
  const result = buildTaskPrompt({ goal: "全体目標", task: task("B", ["src/b.ts"]), upstream: [task("A", ["src/a.ts"])], feedback: "検証失敗" });
  for (const fragment of ["実装する", "全体目標", "src/**", "README.md", "src/a.ts", "src/b.ts", "node --test", "検証失敗", "scope 外に触らない", "受け入れを自分で走らせて結果を報告する", "報告は差分と一致させる"]) assert.ok(result.includes(fragment), fragment);
});
