// コミットの差分。Changes で選んだコミットを右の詳細に出し、ファイルごとに行番号つきで並べる。
// 文字列はすべて textContent で入れ、HTML として解釈させない
import { fmtWhen } from "../lib/format.js";
import { button, el } from "./dom.js";

const STATUS_MARK = { added: "A", deleted: "D", modified: "M", renamed: "R" };
const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
// これより長いファイルは最初は閉じておく
const OPEN_LINE_LIMIT = 400;

function toolbar(ctx) {
  const bar = el("div", undefined, "detail-toolbar");
  if (ctx.onBackToSessions) bar.append(button("‹ Changes", "toolbar-button mobile-back", ctx.onBackToSessions));
  const close = button("×", "toolbar-button", ctx.onCloseCommit);
  close.setAttribute("aria-label", "Close diff");
  close.title = "Close diff";
  const expanded = globalThis.document.body.classList.contains("detail-expanded");
  const expand = button(expanded ? "↙" : "↗", "toolbar-button", ctx.onExpandDetail);
  expand.setAttribute("aria-label", expanded ? "Collapse diff" : "Expand diff");
  expand.title = expanded ? "Collapse diff" : "Expand diff";
  expand.setAttribute("aria-pressed", String(expanded));
  bar.append(expand, close);
  return bar;
}

function fileBlock(file, index) {
  const lines = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const block = el("details", undefined, `diff-file on-${file.status}`);
  block.id = `diff-file-${index}`;
  block.open = !file.binary && lines <= OPEN_LINE_LIMIT;
  const summary = el("summary", undefined, "diff-file-head");
  summary.append(el("span", STATUS_MARK[file.status] || "M", `diff-status on-${file.status}`));
  summary.append(el("span", file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path, "diff-path"));
  summary.append(el("span", `+${file.additions}`, "diff-add-count"), el("span", `−${file.deletions}`, "diff-del-count"));
  block.append(summary);
  if (file.binary) { block.append(el("p", "Binary file", "diff-note")); return block; }
  if (!file.hunks.length) { block.append(el("p", file.status === "renamed" ? "Renamed without changes" : "No textual changes", "diff-note")); return block; }
  const table = el("div", undefined, "diff-lines");
  for (const hunk of file.hunks) {
    table.append(el("div", hunk.header, "diff-hunk"));
    for (const line of hunk.lines) {
      const row = el("div", undefined, `diff-line ${line.kind}`);
      row.append(el("span", line.old === undefined ? "" : String(line.old), "diff-no"),
        el("span", line.new === undefined ? "" : String(line.new), "diff-no"),
        el("span", line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ", "diff-sign"),
        el("span", line.text, "diff-text"));
      table.append(row);
    }
  }
  block.append(table);
  if (file.truncated) block.append(el("p", "This file is too long. The rest is not shown.", "diff-note"));
  return block;
}

// entry は app が持つ /api/diff の取得結果。{ data, loading, error }。commit は Changes の一覧の行
export function renderDiff(aside, entry, commit, view, ctx) {
  const page = el("div", undefined, "diff-view");
  const head = el("header", undefined, "diff-head");
  head.append(el("h3", (entry && entry.data && entry.data.subject) || (commit && commit.subject) || "Commit", "diff-subject"));
  const meta = el("div", undefined, "diff-meta");
  const data = entry && entry.data;
  if (data || commit) {
    const source = data || commit;
    meta.append(el("code", source.short), el("span", source.author || ""), el("span", fmtWhen(source.at, true)));
    if ((source.parents || []).length > 1) meta.append(el("span", "Merge · diff against the first parent", "diff-merge"));
  }
  head.append(meta);
  const refs = (commit && commit.sessions) || [];
  if (refs.length) {
    const chips = el("div", undefined, "change-sessions");
    for (const ref of refs) {
      const session = ((view && view.sessions) || []).find((item) => item.id === ref.id || (item.memberIds || []).includes(ref.id));
      const chip = button(undefined, `session-chip ${ref.client || ""}`, () => { if (session) ctx.onOpenSession(session); });
      chip.append(el("span", CLIENT_LABEL[ref.client] || ref.client || "", "session-chip-client"), el("span", ref.name, "session-chip-name"));
      chip.title = session ? `Open the conversation of ${ref.name}` : `${ref.name} is not loaded`;
      chip.disabled = !session;
      chips.append(chip);
    }
    head.append(chips);
  }
  page.append(head);
  if (!data) {
    page.append(el("p", entry && entry.error ? entry.error : "Loading diff…", entry && entry.error ? "hint" : "empty"));
    aside.replaceChildren(toolbar(ctx), page);
    return;
  }
  if (data.body) page.append(el("pre", data.body, "diff-body"));
  const additions = data.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = data.files.reduce((sum, file) => sum + file.deletions, 0);
  const summary = el("div", undefined, "diff-summary");
  summary.append(el("span", `${data.files.length} ${data.files.length === 1 ? "file" : "files"} changed`),
    el("span", `+${additions}`, "diff-add-count"), el("span", `−${deletions}`, "diff-del-count"));
  page.append(summary);
  const index = el("nav", undefined, "diff-index");
  data.files.forEach((file, position) => {
    const item = button(undefined, "diff-index-item", () => {
      const target = aside.querySelector(`#diff-file-${position}`);
      if (target) { target.open = true; target.scrollIntoView({ block: "start", behavior: "smooth" }); }
    });
    item.append(el("span", STATUS_MARK[file.status] || "M", `diff-status on-${file.status}`), el("span", file.path, "diff-path"),
      el("span", `+${file.additions}`, "diff-add-count"), el("span", `−${file.deletions}`, "diff-del-count"));
    index.append(item);
  });
  page.append(index);
  data.files.forEach((file, position) => page.append(fileBlock(file, position)));
  if (data.truncated) page.append(el("p", "The diff is too large. Some lines are not shown.", "diff-note"));
  aside.replaceChildren(toolbar(ctx), page);
}
