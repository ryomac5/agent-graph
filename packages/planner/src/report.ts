import type { GraphSpec } from "./spec.ts";

export type TaskReport = {
  executor?: string;
  state?: string;
  attempts?: number;
  verify?: { passed: boolean };
  violations?: string[];
  output?: string;
};

export function renderReport(graph: GraphSpec & { session?: string }, results: Record<string, TaskReport>): string {
  const lines = [`# ${graph.session ? `${graph.session}: ` : ""}${graph.goal.trim() || "実行レポート"}`, "", "| タスク | 実行者 | 状態 | 試行 | 検証 |", "| --- | --- | --- | --- | --- |"];
  for (const task of graph.tasks) {
    const result = results[task.id] ?? {};
    const verified = result.verify ? result.verify.passed && !result.violations?.length ? "合格" : "不合格" : "-";
    lines.push(`| ${task.id} ${task.title} | ${result.executor || task.executor} | ${result.state ?? "planned"} | ${result.attempts ?? 0} | ${verified} |`);
  }
  lines.push("", "## 各タスクの報告");
  for (const task of graph.tasks) {
    const output = results[task.id]?.output?.trim();
    if (output) lines.push(`### ${task.id} ${task.title}`, "", output, "");
  }
  return `${lines.join("\n")}\n`;
}
