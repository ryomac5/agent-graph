// Overview。プロジェクトを 1 枚のカードで並べ、直近のセッションと最後の指示まで見せる。
// カードは key を鍵に使い回し、中身だけ書き換える
import { fmtAgo, modelLabel, statusClass } from "../lib/format.js";
import { orbState, visibleProjects } from "../lib/status.js";
import { button, el, keyActivate } from "./dom.js";

const CARD_STATE = { waiting: "判断待ち", failed: "失敗あり", running: "実行中", done: "完了", idle: "待機中", quiet: "休止中" };
const SESSION_STATE = { running: "作業中", waiting: "判断待ち", failed: "失敗", done: "待機中", planned: "待機中", ended: "終了" };
const WAITING_REASON = { permission: "許可待ち", question: "質問待ち" };
const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
// 件数のチップ。人を待たせているものから並べる
const STAT_ORDER = [["waiting", "判断待ち"], ["failed", "失敗"], ["running", "実行中"], ["done", "完了"]];

const shortPath = (path) => String(path || "").replace(/^\/Users\/[^/]+/, "~");

function buildSlot(project, ctx) {
  const slot = el("div", undefined, "card-slot");
  const card = el("div", undefined, "project-card");
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  const open = () => ctx.onOpen(project.key);
  card.addEventListener("click", open);
  keyActivate(card, open);
  slot.append(card);
  return slot;
}

function sessionRow(session, now) {
  const kind = statusClass(session.status);
  const row = el("li", undefined, `card-session on-${kind}`);
  const line = el("div", undefined, "card-session-line");
  if (session.client) line.append(el("span", CLIENT_LABEL[session.client] || session.client, `client-badge ${session.client}`));
  line.append(el("span", session.name, "card-session-name"));
  if (session.model) line.append(el("span", modelLabel(session.model), "card-session-model"));
  const state = (kind === "waiting" && WAITING_REASON[session.waitingReason]) || SESSION_STATE[kind] || session.status;
  line.append(el("span", session.delegations ? `${state} · 委譲 ${session.delegations}` : state, "card-session-state"));
  row.append(line);
  const meta = el("div", undefined, "card-session-meta");
  meta.append(el("span", session.lastPrompt || "指示はまだありません", "card-session-prompt"), el("span", fmtAgo(session.lastAt, now), "card-session-when"));
  row.append(meta);
  return row;
}

export function updateCard(slot, project, unavailable = false, now = new Date()) {
  const state = orbState(project, unavailable);
  const status = unavailable ? "unavailable" : project.status || "idle";
  const card = slot.firstElementChild;
  card.className = `project-card on-${status}` + (state.quiet ? " quiet" : "");
  card.title = project.rootPath || project.name;
  const label = unavailable ? "取得できません" : CARD_STATE[status] || status;
  card.setAttribute("aria-label", `${project.name} · ${label}`);

  const head = el("div", undefined, "card-head");
  const name = el("div", undefined, "card-title");
  name.append(el("span", undefined, "card-dot"), el("strong", project.name, "card-name"));
  head.append(name, el("span", label, "card-state"));

  const sub = el("div", undefined, "card-sub");
  sub.append(el("span", shortPath(project.rootPath), "card-path"));
  if (project.lastActivityAt) sub.append(el("span", fmtAgo(project.lastActivityAt, now), "card-when"));

  const stats = el("div", undefined, "card-stats");
  const live = Number(project.liveSessions || 0);
  stats.append(el("span", live ? `セッション ${live}` : "稼働中のセッションなし", "card-stat"));
  for (const [key, text] of STAT_ORDER) {
    const count = Number((project.counts || {})[key] || 0);
    if (count) stats.append(el("span", `${text} ${count}`, `card-stat on-${key}`));
  }

  const parts = [head, sub, stats];
  const sessions = project.sessions || [];
  if (sessions.length) {
    const list = el("ul", undefined, "card-sessions");
    if (!live) list.append(el("li", "最後のセッション", "card-sessions-caption"));
    for (const session of sessions) list.append(sessionRow(session, now));
    parts.push(list);
  }
  card.replaceChildren(...parts);
}

function summaryLine(projects) {
  const total = { live: 0, waiting: 0, failed: 0, running: 0 };
  for (const project of projects) {
    total.live += Number(project.liveSessions || 0);
    for (const key of ["waiting", "failed", "running"]) total[key] += Number((project.counts || {})[key] || 0);
  }
  const parts = [`${projects.length} プロジェクト`, `セッション ${total.live}`];
  if (total.running) parts.push(`実行中 ${total.running}`);
  if (total.waiting) parts.push(`判断待ち ${total.waiting}`);
  if (total.failed) parts.push(`失敗 ${total.failed}`);
  return parts.join(" · ");
}

// slots は key → slot。消えたプロジェクトだけ外し、残りは中身だけ書き換える。
// unavailable は /api/project の取得に失敗した key の集まり
export function renderOverview(canvas, overview, ctx, unavailable = new Map()) {
  canvas.classList.add("overview");
  const all = (overview && overview.projects) || [];
  const projects = visibleProjects(all, ctx.showInactive);
  const page = el("section", undefined, "workspace");
  const heading = el("div", undefined, "workspace-heading");
  const title = el("div");
  title.append(el("h2", "プロジェクト"), el("p", overview ? summaryLine(projects) : "", "workspace-description"));
  const filters = el("div", undefined, "project-filters");
  filters.setAttribute("aria-label", "表示するプロジェクト");
  for (const [show, label] of [[false, "稼働中"], [true, "すべて"]]) {
    const control = button(label, Boolean(ctx.showInactive) === show ? "selected" : "", () => ctx.onShowInactive(show));
    control.setAttribute("aria-pressed", String(Boolean(ctx.showInactive) === show));
    filters.append(control);
  }
  heading.append(title, filters);
  const inner = el("div", undefined, "overview-inner");
  page.append(heading, inner);
  if (!projects.length) inner.append(el("p", overview ? (ctx.showInactive ? "まだプロジェクトがありません。" : "稼働中のプロジェクトはありません。履歴は「すべて」から確認できます。") : "接続しています…", "empty"));
  const keys = new Set(projects.map((p) => p.key));
  for (const [key, slot] of ctx.orbSlots) if (!keys.has(key)) { slot.remove(); ctx.orbSlots.delete(key); }
  const now = new Date();
  for (const project of projects) {
    let slot = ctx.orbSlots.get(project.key);
    if (!slot) { slot = buildSlot(project, ctx); ctx.orbSlots.set(project.key, slot); }
    inner.append(slot);
    updateCard(slot, project, unavailable.has(project.key), now);
  }
  canvas.replaceChildren(page);
}
