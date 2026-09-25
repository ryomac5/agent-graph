import type { TaskSpec } from "./spec.ts";

export function buildTaskPrompt({ goal, task, upstream, feedback }: {
  goal: string;
  task: TaskSpec;
  upstream: TaskSpec[];
  feedback?: string;
}): string {
  const lines = [`# タスク ${task.id}: ${task.title}`, "", "## 目的", task.prompt.trim(), ""];
  if (goal.trim()) lines.push("## 全体の目標（文脈）", goal.trim(), "");
  if (task.scope.length) lines.push("## 触ってよいファイル（scope）", ...task.scope.map((path) => `- ${path}`), "", "scope 外の変更は不合格になります。", "");
  const inputs = [...new Set([...task.inputs, ...upstream.flatMap((source) => source.outputs)])];
  if (inputs.length) lines.push("## 上流からの入力（読んでから始める）", ...inputs.map((path) => `- ${path}`), "");
  if (task.outputs.length) lines.push("## 期待する成果物", ...task.outputs.map((path) => `- ${path}`), "");
  if (task.accept.length) lines.push("## 受け入れ条件（完了前に自分でも実行し、全て通すこと）", ...task.accept.map((command) => "- `" + command + "`"), "");
  if (feedback?.trim()) lines.push("## 前回不合格の理由", feedback.trim(), "", "上記を解消してください。", "");
  lines.push("## 作業上の規則", "- scope 外に触らない", "- 受け入れを自分で走らせて結果を報告する", "- 報告は差分と一致させる");
  return `${lines.join("\n")}\n`;
}
