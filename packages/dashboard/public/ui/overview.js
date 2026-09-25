// Overview。プロジェクトを 1 つの丸として浮かべる。丸は key を鍵に使い回し、浮遊の位相を保つ
import { orbState } from "../lib/status.js";
import { button, el } from "./dom.js";

// 浮遊の周期と位相。プロジェクトごとにずらして同じ動きに揃わないようにする
const ORB_BASE_SEC = 7, ORB_STEP_SEC = 1.3, ORB_DUR_SLOTS = 5, ORB_DELAY_SLOTS = 7;

function buildSlot(project, index, ctx) {
  const slot = el("div", undefined, "orb-slot");
  slot.style.setProperty("--orb-dur", `${ORB_BASE_SEC + (index % ORB_DUR_SLOTS) * ORB_STEP_SEC}s`);
  slot.style.setProperty("--orb-delay", `${-(index % ORB_DELAY_SLOTS) * ORB_STEP_SEC}s`);
  const orb = button(undefined, "orb", () => ctx.onOpen(project.key));
  orb.append(el("strong", "", "orb-name"), el("span", "", "orb-live"), el("span", "", "orb-state"));
  slot.append(orb);
  return slot;
}

export function updateOrb(slot, project) {
  const state = orbState(project);
  const orb = slot.firstElementChild;
  orb.className = "orb" + (state.key ? ` on-${state.key}` : state.quiet ? " quiet" : "");
  orb.title = project.rootPath || project.name;
  orb.setAttribute("aria-label", `${project.name} · ${state.text}`);
  orb.children[0].textContent = project.name;
  orb.children[1].textContent = `${project.liveSessions || 0} sessions`;
  orb.children[2].textContent = state.text;
}

// slots は key → slot。消えたプロジェクトだけ外し、残りは文言と状態だけ書き換える
export function renderOverview(canvas, overview, ctx) {
  canvas.classList.add("overview");
  const projects = (overview && overview.projects) || [];
  if (!projects.length) {
    ctx.orbSlots.clear();
    canvas.replaceChildren(el("p", overview ? "No projects yet" : "Connecting…", "empty"));
    return;
  }
  let inner = canvas.firstElementChild;
  if (!inner || inner.className !== "overview-inner") {
    inner = el("div", undefined, "overview-inner");
    canvas.replaceChildren(inner);
  }
  const keys = new Set(projects.map((p) => p.key));
  for (const [key, slot] of ctx.orbSlots) if (!keys.has(key)) { slot.remove(); ctx.orbSlots.delete(key); }
  projects.forEach((project, index) => {
    let slot = ctx.orbSlots.get(project.key);
    if (!slot) { slot = buildSlot(project, index, ctx); ctx.orbSlots.set(project.key, slot); }
    if (slot.parentNode !== inner) inner.append(slot);
    updateOrb(slot, project);
  });
}
