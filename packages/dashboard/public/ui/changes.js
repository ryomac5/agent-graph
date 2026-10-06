// Changes タブ。既定のブランチと作業中のブランチのコミットを、git log --graph のようなツリーで並べる。
// 行を押すと右の詳細にそのコミットの差分を出す。セッションの札を押すと、そのセッションの会話を開く
import { fmtWhen } from "../lib/format.js";
import { layoutLanes } from "../lib/lanes.js";
import { button, el, keyActivate, svgEl } from "./dom.js";

const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
// 1 行の高さと列の幅。線は行ごとの SVG に描き、行の高さを固定して上下をつなげる
const ROW_H = 58;
const COL_W = 14;
const PAD = 9;
const LANE_COLORS = ["#007aff", "#af52de", "#34c759", "#ff9500", "#ff2d55", "#5ac8fa", "#a2845e", "#5856d6"];
const laneColor = (index) => LANE_COLORS[index % LANE_COLORS.length];
const x = (index) => PAD + index * COL_W;

function sessionChips(refs, view, ctx) {
  const chips = el("div", undefined, "change-sessions");
  for (const ref of refs) {
    const session = (view.sessions || []).find((item) => item.id === ref.id);
    const chip = button(undefined, `session-chip ${ref.client || ""}${ctx.selectedScope === ref.id && !ctx.selectedCommit ? " selected" : ""}`, (event) => {
      event?.stopPropagation?.();
      if (session) ctx.onOpenSession(session);
    });
    chip.append(el("span", CLIENT_LABEL[ref.client] || ref.client || "", "session-chip-client"), el("span", ref.name, "session-chip-name"));
    chip.title = session ? `Open ${ref.name}` : `${ref.name} is not loaded`;
    chip.disabled = !session;
    chips.append(chip);
  }
  return chips;
}

// 曲線で列を移る線。同じ列ならまっすぐ
function link(from, y1, to, y2, color) {
  const d = from === to ? `M${x(from)} ${y1}V${y2}` : `M${x(from)} ${y1}C${x(from)} ${(y1 + y2) / 2} ${x(to)} ${(y1 + y2) / 2} ${x(to)} ${y2}`;
  return svgEl("path", { d, stroke: color, "stroke-width": 2, fill: "none", "stroke-linecap": "round" });
}

function laneCell(row, commit, width) {
  const svg = svgEl("svg", { width: x(width - 1) + PAD, height: ROW_H, viewBox: `0 0 ${x(width - 1) + PAD} ${ROW_H}`, class: "change-lanes", "aria-hidden": "true" });
  const mid = ROW_H / 2;
  row.before.forEach((sha, index) => {
    if (sha === null || sha === undefined) return;
    if (sha === commit.sha) { svg.append(link(index, 0, row.col, mid, laneColor(index))); return; }
    // 通り過ぎる列。下端で同じコミットを待つ列へつなぐ
    const target = row.after.indexOf(sha);
    svg.append(link(index, 0, target < 0 ? index : target, ROW_H, laneColor(index)));
  });
  for (const target of row.edges) svg.append(link(row.col, mid, target, ROW_H, laneColor(target)));
  const merge = (commit.parents || []).length > 1;
  svg.append(svgEl("circle", { cx: x(row.col), cy: mid, r: merge ? 4 : 5, fill: merge ? "white" : laneColor(row.col),
    stroke: laneColor(row.col), "stroke-width": merge ? 2.5 : 0 }));
  return svg;
}

function stats(commit) {
  if ((commit.parents || []).length > 1) return "merge";
  const parts = [];
  if (commit.insertions || commit.deletions) parts.push(`+${commit.insertions} −${commit.deletions}`);
  if (commit.files) parts.push(`${commit.files} ${commit.files === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

function commitRow(commit, lane, width, view, ctx) {
  const selected = ctx.selectedCommit === commit.sha;
  const row = el("div", undefined, `change-row${selected ? " selected" : ""}${commit.sessions.length ? "" : " unlinked"}`);
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.title = `${commit.short} · ${commit.subject}`;
  const open = () => ctx.onOpenCommit(view.project.key, commit.sha);
  row.addEventListener("click", open);
  keyActivate(row, open);
  row.append(laneCell(lane, commit, width));
  const body = el("div", undefined, "change-body");
  const head = el("div", undefined, "change-head");
  for (const ref of commit.refs || []) head.append(el("span", ref, `change-ref${ref === ctx.defaultBranch ? " is-base" : ""}`));
  head.append(el("span", commit.subject, "change-subject"));
  body.append(head);
  const meta = el("div", undefined, "change-meta");
  meta.append(el("code", commit.short), el("span", fmtWhen(commit.at)));
  const numbers = stats(commit);
  if (numbers) meta.append(el("span", numbers, "change-stat"));
  if (commit.author) meta.append(el("span", commit.author, "change-author"));
  body.append(meta);
  row.append(body);
  if (commit.sessions.length) row.append(sessionChips(commit.sessions, view, ctx));
  else row.append(el("span", "No agent", "change-manual"));
  return row;
}

// entry は app が持つ /api/changes の取得結果。{ data, loading, error }
export function buildChanges(view, entry, ctx) {
  const box = el("div", undefined, "changes");
  if (!entry || (!entry.data && entry.loading)) { box.append(el("p", "Loading git history…", "empty")); return box; }
  if (entry.error && !entry.data) { box.append(el("p", entry.error, "hint")); return box; }
  const data = entry.data;
  const head = el("div", undefined, "change-section-head");
  head.append(el("h4", "Commits", "change-section-title"));
  const open = (data.branches || []).filter((name) => name !== data.branch);
  head.append(el("span", open.length ? `${data.branch} and ${open.length} open ${open.length === 1 ? "branch" : "branches"}` : data.branch, "change-section-sub"));
  box.append(head);
  const list = el("div", undefined, "change-tree");
  const { rows, width } = layoutLanes(data.commits);
  const tree = { ...ctx, defaultBranch: data.branch };
  data.commits.forEach((commit, index) => list.append(commitRow(commit, rows[index], width, view, tree)));
  if (!data.commits.length) list.append(el("p", "No commits yet.", "empty"));
  box.append(list);
  if (data.hasMore) box.append(button(entry.loading ? "Loading…" : "Load older commits", "toolbar-button change-more", () => ctx.onMoreChanges(view.project.key)));
  return box;
}
