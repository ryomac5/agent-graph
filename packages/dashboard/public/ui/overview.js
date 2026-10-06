// Overview。プロジェクトを 1 枚のカードで並べ、直近のセッションと最後の指示まで見せる。
// カードは key を鍵に使い回し、中身だけ書き換える
import { fmtAgo, modelLabel, statusClass } from "../lib/format.js";
import { isActiveProject, orbState, visibleProjects } from "../lib/status.js";
import { button, el, keyActivate } from "./dom.js";

const CARD_STATE = { waiting: "Waiting", failed: "Failed", running: "Running", done: "Done", idle: "Idle", quiet: "Quiet" };
const SESSION_STATE = { running: "Working", waiting: "Waiting", failed: "Failed", done: "Idle", planned: "Idle", ended: "Ended" };
const WAITING_REASON = { permission: "Needs permission", question: "Has a question" };
const CLIENT_LABEL = { claude: "Claude", codex: "Codex", planner: "Planner" };
// 件数のチップ。人を待たせているものから並べる
const STAT_ORDER = [["waiting", "Waiting"], ["failed", "Failed"], ["running", "Running"], ["done", "Done"]];

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
  line.append(el("span", session.delegations ? `${state} · ${session.delegations} delegated` : state, "card-session-state"));
  row.append(line);
  const meta = el("div", undefined, "card-session-meta");
  meta.append(el("span", session.lastPrompt || "No prompts yet", "card-session-prompt"), el("span", fmtAgo(session.lastAt, now), "card-session-when"));
  row.append(meta);
  return row;
}

export function updateCard(slot, project, unavailable = false, now = new Date()) {
  const state = orbState(project, unavailable);
  const status = unavailable ? "unavailable" : project.status || "idle";
  const card = slot.firstElementChild;
  card.className = `project-card on-${status}` + (state.quiet ? " quiet" : "");
  card.title = project.rootPath || project.name;
  const label = unavailable ? "Unavailable" : CARD_STATE[status] || status;
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
  stats.append(el("span", live ? `${live} ${live === 1 ? "session" : "sessions"}` : "No live sessions", "card-stat"));
  for (const [key, text] of STAT_ORDER) {
    const count = Number((project.counts || {})[key] || 0);
    if (count) stats.append(el("span", `${text} ${count}`, `card-stat on-${key}`));
  }

  const parts = [head, sub, stats];
  const sessions = project.sessions || [];
  if (sessions.length) {
    const list = el("ul", undefined, "card-sessions");
    if (!live) list.append(el("li", "Last session", "card-sessions-caption"));
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
  const parts = [`${projects.length} ${projects.length === 1 ? "project" : "projects"}`, `${total.live} ${total.live === 1 ? "session" : "sessions"}`];
  if (total.running) parts.push(`${total.running} running`);
  if (total.waiting) parts.push(`${total.waiting} waiting`);
  if (total.failed) parts.push(`${total.failed} failed`);
  return parts.join(" · ");
}

// 稼働中を上の Active に、7 日以内に動いた残りを下の Recent に並べる。
// slots は key → slot。消えたプロジェクトだけ外し、残りは中身だけ書き換える。
// unavailable は /api/project の取得に失敗した key の集まり
export function renderOverview(canvas, overview, ctx, unavailable = new Map()) {
  canvas.classList.add("overview");
  const now = ctx.now ? ctx.now() : new Date();
  const listed = visibleProjects((overview && overview.projects) || [], now);
  const active = listed.filter(isActiveProject);
  const recent = listed.filter((project) => !isActiveProject(project));
  const page = el("section", undefined, "workspace");
  const heading = el("div", undefined, "workspace-heading");
  const title = el("div");
  title.append(el("h2", "Projects"), el("p", overview ? summaryLine(active) : "", "workspace-description"));
  heading.append(title);
  page.append(heading);
  const keys = new Set(listed.map((p) => p.key));
  for (const [key, slot] of ctx.orbSlots) if (!keys.has(key)) { slot.remove(); ctx.orbSlots.delete(key); }
  const section = (name, projects, empty, className) => {
    const block = el("section", undefined, `overview-section ${className}`);
    const head = el("div", undefined, "overview-section-head");
    head.append(el("h3", name), el("span", String(projects.length), "overview-section-count"));
    const inner = el("div", undefined, "overview-inner");
    block.append(head, inner);
    if (!projects.length && empty) inner.append(el("p", empty, "empty"));
    for (const project of projects) {
      let slot = ctx.orbSlots.get(project.key);
      if (!slot) { slot = buildSlot(project, ctx); ctx.orbSlots.set(project.key, slot); }
      inner.append(slot);
      updateCard(slot, project, unavailable.has(project.key), now);
    }
    return block;
  };
  if (!overview) page.append(el("p", "Connecting…", "empty"));
  else {
    page.append(section("Active", active, "No active projects.", "is-active"));
    if (recent.length) page.append(section("Recent", recent, "", "is-recent"));
  }
  canvas.replaceChildren(page);
}
