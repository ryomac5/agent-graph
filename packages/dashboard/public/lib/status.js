// 状態の集計と優先表示、利用枠の色分け。DOM に触れない。
import { statusClass } from "./format.js";

// 丸に出す状態の優先順。人を待たせているものから拾う
export const ORB_PRIORITY = ["waiting", "failed", "running", "done"];
export const STATE_TEXT = { running: "Running", waiting: "Waiting", failed: "Failed", done: "Done" };

export function isLive(session) { return session && statusClass(session.status) !== "ended"; }

// root を除いた子の件数。dismissed に入っている id は数えない
export function countNodes(nodes, dismissed = new Set(), prefix = "") {
  const counts = { running: 0, waiting: 0, failed: 0, done: 0 };
  for (const node of nodes || []) {
    if (node.kind === "root") continue;
    if (dismissed.has(`${prefix}${node.id}`)) continue;
    const cls = statusClass(node.status);
    if (cls in counts) counts[cls] += 1;
  }
  return counts;
}

// 生きているセッションと planner のグラフを合わせて数える
export function countProject(view, dismissed = new Set()) {
  const counts = { running: 0, waiting: 0, failed: 0, done: 0 };
  const add = (part) => { for (const key of Object.keys(counts)) counts[key] += part[key]; };
  for (const session of (view && view.sessions) || []) {
    if (!isLive(session)) continue;
    add(countNodes(session.nodes, dismissed, `${session.id}::`));
  }
  for (const graph of (view && view.graphs) || []) add(countNodes(graph.nodes, dismissed, `${graph.id}::`));
  return counts;
}

export function sumCounts(list) {
  const counts = { running: 0, waiting: 0, failed: 0, done: 0 };
  for (const item of list || []) for (const key of Object.keys(counts)) counts[key] += Number(item[key] || 0);
  return counts;
}

// Overview の丸に出す言葉。Unavailable > Quiet > 優先状態 > Idle
export function orbState(summary) {
  const counts = summary.counts || {};
  const key = ORB_PRIORITY.find((k) => counts[k]) || "";
  if (summary.status === "unavailable" || summary.error) return { key: "", text: "Unavailable", quiet: true };
  if (!summary.liveSessions) return { key: "", text: "Quiet", quiet: true };
  if (key) return { key, text: `${STATE_TEXT[key]} ${counts[key]}`, quiet: false };
  return { key: "", text: "Idle", quiet: false };
}

// 利用量のバー。70% で色を上げ、90% で警告色にする
export const USAGE_WARN = 70, USAGE_HIGH = 90;
export function usageLevel(percent) {
  const used = Math.max(0, Math.min(100, Number(percent) || 0));
  return used >= USAGE_HIGH ? "high" : used >= USAGE_WARN ? "warn" : "";
}

// 判断待ちのボタン。task の waiting_human と conflict は 3 つ、失敗は 2 つ
export function actionsFor(node) {
  if (!node) return [];
  const waiting = node.status === "waiting_human" || node.status === "conflict";
  if (node.kind === "task" && waiting) return [["approve", "Approve"], ["retry", "Retry"], ["reject", "Reject"]];
  if (node.kind === "task" && ["failed", "rejected", "timeout", "lost"].includes(node.status)) return [["retry", "Retry"], ["reject", "Reject"]];
  if (node.kind !== "task" && ["failed", "lost", "timeout"].includes(node.status)) return [["retry", "Retry"]];
  return [];
}
