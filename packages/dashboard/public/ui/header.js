// ヘッダー 2 段。1 段目にピル列と件数、2 段目に凡例と利用枠と更新時刻
import { fmtUntil, fmtWhen } from "../lib/format.js";
import { STATE_TEXT, usageLevel } from "../lib/status.js";
import { button, el } from "./dom.js";

function buildProjectBar(projects, selectedKeys, ctx) {
  const parts = [button("← Overview", "back", () => ctx.onOpen(null))];
  for (const project of projects) {
    const picked = selectedKeys.includes(project.key);
    const pill = button(project.name, "pill" + (picked ? " on" : ""), () => ctx.onOpen(project.key, true));
    pill.title = project.rootPath || project.key;
    pill.setAttribute("aria-pressed", picked ? "true" : "false");
    parts.push(pill);
  }
  return parts;
}

// 窓の並びと表示名はサーバーが決める。ここは順に描くだけ
export function renderUsage(doc, usage, now = new Date()) {
  const box = doc.getElementById("usage");
  const sub = doc.getElementById("head-sub");
  const windows = ((usage || {}).windows || []).filter((w) => w && typeof w.percent === "number");
  sub.hidden = !windows.length;
  box.replaceChildren(...windows.map((w) => {
    const item = el("div", undefined, "usage-item");
    const used = Math.max(0, Math.min(100, w.percent));
    const fill = el("div", undefined, "usage-fill" + (usageLevel(used) ? ` ${usageLevel(used)}` : ""));
    fill.style.width = `${used}%`;
    const bar = el("div", undefined, "usage-bar");
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-valuenow", String(Math.round(used)));
    bar.setAttribute("aria-label", w.label || w.key);
    bar.append(fill);
    if (w.resetsAt) item.title = `Resets ${fmtWhen(w.resetsAt, true, now)}`;
    item.append(el("span", w.label || w.key), bar, el("span", `${Math.round(used)}%`, "usage-value"));
    const until = fmtUntil(w.resetsAt, now);
    if (until) item.append(el("span", `· ${until}`, "usage-until"));
    return item;
  }));
}

// projects は全プロジェクトの一覧、selected は開いている key。counts は表示中の範囲の件数
export function renderHeader(doc, { projects, selected, counts, usage, connection, updatedAt }, ctx) {
  const bar = doc.getElementById("project-bar");
  bar.replaceChildren(...(selected.length ? buildProjectBar(projects, selected, ctx) : []));
  doc.getElementById("project-count").textContent = selected.length
    ? `${selected.length} / ${projects.length} projects`
    : `${projects.length} projects`;
  doc.getElementById("summary").replaceChildren(
    ...Object.keys(STATE_TEXT).map((key) => el("span", `${STATE_TEXT[key]} ${counts[key] || 0}`, counts[key] ? `on-${key}` : "zero")));
  const conn = doc.getElementById("connection");
  conn.textContent = connection === "live" ? "Live" : connection === "offline" ? "Offline" : "Connecting";
  conn.className = `connection ${connection || ""}`;
  doc.getElementById("updated").textContent = updatedAt ? `Updated ${fmtWhen(updatedAt)}` : "";
  const names = projects.filter((p) => selected.includes(p.key)).map((p) => p.name);
  const prefix = `${counts.running ? `(${counts.running}) ` : ""}${counts.waiting ? "⏸ " : ""}`;
  doc.title = `${prefix}Agent Console${names.length ? ` · ${names.join(", ")}` : ""}`;
  renderUsage(doc, usage);
}
