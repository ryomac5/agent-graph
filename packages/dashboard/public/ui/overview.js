// Overview。プロジェクトを 1 つの丸として浮かべる。丸は key を鍵に使い回し、浮遊の位相を保つ
import { orbState, visibleProjects } from "../lib/status.js";
import { button, el } from "./dom.js";

function buildSlot(project, index, ctx) {
  const slot = el("div", undefined, "orb-slot");
  const orb = button(undefined, "orb", () => ctx.onOpen(project.key));
  orb.append(el("strong", "", "orb-name"), el("span", "", "orb-live"), el("span", "", "orb-state"), el("span", "", "orb-path"));
  slot.append(orb);
  return slot;
}

export function updateOrb(slot, project, unavailable = false) {
  const state = orbState(project, unavailable);
  const orb = slot.firstElementChild;
  orb.className = "orb" + (state.key ? ` on-${state.key}` : state.quiet ? " quiet" : "");
  orb.title = project.rootPath || project.name;
  orb.setAttribute("aria-label", `${project.name} · ${state.text}`);
  orb.children[0].textContent = project.name;
  orb.children[1].textContent = `${project.liveSessions || 0} セッション稼働中`;
  orb.children[2].textContent = state.text;
  orb.children[3].textContent = "";
}

// slots は key → slot。消えたプロジェクトだけ外し、残りは文言と状態だけ書き換える。
// unavailable は /api/project の取得に失敗した key の集まり
export function renderOverview(canvas, overview, ctx, unavailable = new Map()) {
  canvas.classList.add("overview");
  const all = (overview && overview.projects) || [];
  const projects = visibleProjects(all, ctx.showInactive);
  const page = el("section", undefined, "workspace");
  const heading = el("div", undefined, "workspace-heading");
  const title = el("div");
  title.append(el("h2", "プロジェクト"));
  const filters = el("div", undefined, "project-filters");
  filters.setAttribute("aria-label", "表示するプロジェクト");
  for (const [show, label] of [[false, "稼働中"], [true, "すべて"]]) {
    const control = button(label, ctx.showInactive === show || (!ctx.showInactive && !show) ? "selected" : "", () => ctx.onShowInactive(show));
    control.setAttribute("aria-pressed", String(Boolean(ctx.showInactive) === show));
    filters.append(control);
  }
  heading.append(title, filters);
  const inner = el("div", undefined, "overview-inner");
  page.append(heading, inner);
  if (!projects.length) inner.append(el("p", overview ? (ctx.showInactive ? "まだプロジェクトがありません。" : "稼働中のプロジェクトはありません。履歴は「すべて」から確認できます。") : "接続しています…", "empty"));
  const keys = new Set(projects.map((p) => p.key));
  for (const [key, slot] of ctx.orbSlots) if (!keys.has(key)) { slot.remove(); ctx.orbSlots.delete(key); }
  projects.forEach((project, index) => {
    let slot = ctx.orbSlots.get(project.key);
    if (!slot) { slot = buildSlot(project, index, ctx); ctx.orbSlots.set(project.key, slot); }
    if (slot.parentNode !== inner) inner.append(slot);
    updateOrb(slot, project, unavailable.has(project.key));
  });
  canvas.replaceChildren(page);
}
