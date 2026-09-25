// ノードの整理。× で隠したものと、古い完了の自動の畳みを 1 つのチップにまとめる。DOM に触れない。
import { statusClass } from "./format.js";
import { ARCHIVE_ID, isForward } from "./layout.js";

// × で隠せるのは終わったノードだけ。作業中・判断待ちは誤って消さないよう出さない
export const DISMISSABLE_STATUS = new Set(["done", "failed", "rejected", "lost", "timeout", "denied", "ended"]);
export function isDismissable(node) {
  return !!node && node.kind !== "root" && node.kind !== "archive" && DISMISSABLE_STATUS.has(node.status);
}
export const dismissKey = (scopeId, nodeId) => `${scopeId}::${nodeId}`;

// 直近 2 ターンより前に完了した末端の委譲は畳む。失敗・作業中・判断待ちと、子を持つものは畳まない
export function visibleView(scope, dismissed = new Set(), expanded = false) {
  const nodes = scope.nodes || [];
  const edges = scope.edges || [];
  const forward = edges.filter(isForward);
  const turns = scope.turns || [];
  const cutoff = turns.length >= 2 ? turns[turns.length - 2].at || "" : "";
  const hasChildren = new Set(forward.map((e) => e.from));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const manualRoots = nodes.filter((n) => isDismissable(n) && dismissed.has(dismissKey(scope.id, n.id)));
  const roots = new Set(manualRoots.map((n) => n.id));
  const manualHidden = new Set();
  const keepVisible = new Set(["running", "waiting", "failed"]);
  const stack = manualRoots.map((n) => n.id);
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    const node = byId.get(id);
    if (!node || node.kind === "root" || seen.has(id)) continue;
    seen.add(id);
    // 子孫でも作業中・判断待ち・失敗なら見せ続ける。畳んだ本人は隠す
    const active = !roots.has(id) && keepVisible.has(statusClass(node.status));
    if (!active) manualHidden.add(id);
    for (const e of forward) if (e.from === id) stack.push(e.to);
  }
  const autoHidden = nodes.filter((n) =>
    n.kind !== "root" && n.kind !== "task" && !hasChildren.has(n.id) && !manualHidden.has(n.id)
    && statusClass(n.status) === "done" && !!cutoff && !!n.startedAt && n.startedAt < cutoff);
  const archived = nodes.filter((n) => manualHidden.has(n.id)).concat(autoHidden);
  if (!archived.length) return { nodes, edges, archived: 0, expanded: false, hidden: new Set() };
  const hidden = new Set(expanded ? [] : archived.map((n) => n.id));
  const root = nodes.find((n) => n.kind === "root");
  const chip = { id: ARCHIVE_ID, kind: "archive", status: "archive", title: `${archived.length} hidden`, count: archived.length };
  const shownNodes = nodes.filter((n) => !hidden.has(n.id)).concat([chip]);
  const shownEdges = edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to));
  if (root) shownEdges.push({ id: `${root.id}->${ARCHIVE_ID}`, from: root.id, to: ARCHIVE_ID, kind: "delegate" });
  return { nodes: shownNodes, edges: shownEdges, archived: archived.length, expanded, hidden };
}

// 前回の描画に無かった辺と node。初回はすべて既知にして一斉には光らせない
export function diffKnown(known, ids) {
  if (!known) return { known: new Set(ids), fresh: new Set() };
  const fresh = new Set(ids.filter((id) => !known.has(id)));
  for (const id of fresh) known.add(id);
  return { known, fresh };
}
