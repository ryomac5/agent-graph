// Changes タブ。既定のブランチのコミットを日ごとに並べ、各コミットを作ったセッションを札で添える。
// 札を押すと、そのセッションの会話を右の詳細に開く
import { fmtAgo } from "../lib/format.js";
import { button, el } from "./dom.js";

const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
const DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

function dayOf(at) {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : DAY.format(date);
}

function sessionChips(refs, view, ctx) {
  const chips = el("div", undefined, "change-sessions");
  for (const ref of refs) {
    const session = (view.sessions || []).find((item) => item.id === ref.id);
    const chip = button(undefined, `session-chip ${ref.client || ""}${ctx.selectedScope === ref.id ? " selected" : ""}`, () => {
      if (session) ctx.onOpenSession(session);
    });
    chip.append(el("span", CLIENT_LABEL[ref.client] || ref.client || "", "session-chip-client"), el("span", ref.name, "session-chip-name"));
    chip.title = session ? `Open ${ref.name}` : `${ref.name} is not loaded`;
    chip.disabled = !session;
    chips.append(chip);
  }
  return chips;
}

function stats(commit) {
  const parts = [];
  if (commit.insertions || commit.deletions) parts.push(`+${commit.insertions} −${commit.deletions}`);
  if (commit.files) parts.push(`${commit.files} ${commit.files === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

function commitRow(commit, view, ctx, nested = false) {
  const row = el("article", undefined, `change${commit.merge ? " is-merge" : ""}${nested ? " nested" : ""}${commit.sessions.length ? "" : " unlinked"}`);
  const head = el("div", undefined, "change-head");
  head.append(el("span", commit.merge && commit.merge.branch ? `Merge ${commit.merge.branch}` : commit.subject, "change-subject"));
  if (commit.sessions.length) head.append(sessionChips(commit.sessions, view, ctx));
  else head.append(el("span", "No agent", "change-manual"));
  row.append(head);
  const meta = el("div", undefined, "change-meta");
  meta.append(el("code", commit.short), el("span", TIME.format(new Date(commit.at))));
  const numbers = stats(commit);
  if (numbers) meta.append(el("span", numbers, "change-stat"));
  if (commit.author) meta.append(el("span", commit.author, "change-author"));
  row.append(meta);
  if (commit.merge && commit.merge.commits.length) {
    const inner = el("details", undefined, "change-children");
    inner.append(el("summary", `${commit.merge.commits.length} ${commit.merge.commits.length === 1 ? "commit" : "commits"}`));
    for (const child of commit.merge.commits) inner.append(commitRow(child, view, ctx, true));
    row.append(inner);
  }
  return row;
}

// entry は app が持つ /api/changes の取得結果。{ data, loading, error }
export function buildChanges(view, entry, ctx) {
  const box = el("div", undefined, "changes");
  if (!entry || (!entry.data && entry.loading)) { box.append(el("p", "Loading git history…", "empty")); return box; }
  if (entry.error && !entry.data) { box.append(el("p", entry.error, "hint")); return box; }
  const data = entry.data;
  if (data.branches && data.branches.length) {
    const open = el("section", undefined, "change-section");
    open.append(el("h4", "In progress", "change-section-title"));
    for (const branch of data.branches) {
      const row = el("article", undefined, "change branch");
      const head = el("div", undefined, "change-head");
      head.append(el("code", branch.name, "change-branch"), el("span", branch.subject, "change-subject"));
      if (branch.sessions.length) head.append(sessionChips(branch.sessions, view, ctx));
      row.append(head);
      const meta = el("div", undefined, "change-meta");
      meta.append(el("span", `${branch.ahead} ${branch.ahead === 1 ? "commit" : "commits"} ahead of ${data.branch}`), el("span", fmtAgo(branch.at)));
      row.append(meta);
      open.append(row);
    }
    box.append(open);
  }
  const history = el("section", undefined, "change-section");
  history.append(el("h4", `History of ${data.branch}`, "change-section-title"));
  let day = "";
  for (const commit of data.commits) {
    const label = dayOf(commit.at);
    if (label !== day) { history.append(el("h5", label, "change-day")); day = label; }
    history.append(commitRow(commit, view, ctx));
  }
  if (!data.commits.length) history.append(el("p", "No commits yet.", "empty"));
  box.append(history);
  if (data.hasMore) box.append(button(entry.loading ? "Loading…" : "Load older commits", "toolbar-button change-more", () => ctx.onMoreChanges(view.project.key)));
  return box;
}
