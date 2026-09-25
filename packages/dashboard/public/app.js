// 画面の起点。契約の Overview と ProjectView を feed で受け、ヘッダー・canvas・詳細に配る
import { countProject, sumCounts } from "./lib/status.js";
import { dismissKey } from "./lib/visible.js";
import { renderDetail } from "./ui/detail.js";
import { el } from "./ui/dom.js";
import { openFeed } from "./ui/feed.js";
import { renderHeader } from "./ui/header.js";
import { renderOverview } from "./ui/overview.js";
import { buildProjectSection, scopesOf } from "./ui/project.js";
import { setupSplitter } from "./ui/splitter.js";
import { toast } from "./ui/toast.js";

const TOKEN = (document.querySelector('meta[name="agent-graph-token"]') || {}).content || "";
const POST_HEADERS = { "Content-Type": "application/json", "X-Agent-Graph-Token": TOKEN };
const PROJECT_KEY = "agent-graph:project";
const DISMISS_KEY = "agent-graph:dismissed";
const CANVAS_MARGIN = 64;
const CANVAS_MAX = 1200;

function loadJson(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value == null ? fallback : value; }
  catch { return fallback; }
}
function loadSelectedProjects() {
  const value = loadJson(PROJECT_KEY, []);
  if (Array.isArray(value)) return [...new Set(value.filter((k) => typeof k === "string"))];
  return typeof value === "string" ? [value] : [];
}

const state = {
  overview: null, views: new Map(), feeds: new Map(), feedState: new Map(), updatedAt: "",
  selectedProjects: loadSelectedProjects(), selectedScope: null, selectedNode: null,
  dismissed: new Set(loadJson(DISMISS_KEY, [])), expandedArchive: new Set(),
  knownEdges: new Map(), knownNodes: new Map(), fresh: new Map(), zoom: new Map(),
  expandedRounds: new Set(), hiddenTurns: new Set(), factsOpen: { value: false }, chatView: { key: "", top: 0, stick: true },
};
let previousCanvas = "";
let previousDetail = "";

const canvas = document.getElementById("canvas");
const aside = document.getElementById("detail");

// 403 やエラーページで JSON を読めないことがある。文面に落として画面を止めない
async function readMessage(res) {
  try { const body = await res.json(); return body.message || body.error || `HTTP ${res.status}`; }
  catch { return `Server error ${res.status}`; }
}

async function postAction(body) {
  try {
    const res = await fetch("/api/action", { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
    const message = await readMessage(res);
    toast(res.ok ? message : `Failed: ${message}`);
    return message;
  } catch (err) {
    toast(`Failed: ${err.message}`);
    return `Failed: ${err.message}`;
  } finally {
    previousCanvas = "";
    previousDetail = "";
  }
}

function projectKeyOf(scopeId) {
  for (const [key, view] of state.views) if (scopesOf(view).some((s) => s.id === scopeId)) return key;
  return state.selectedProjects[0] || "";
}

function currentScope() {
  if (!state.selectedScope) return null;
  for (const view of state.views.values()) {
    const scope = scopesOf(view).find((s) => s.id === state.selectedScope);
    if (scope) return scope;
  }
  return null;
}

const projects = () => (state.overview && state.overview.projects) || [];
const selectedViews = () => state.selectedProjects.map((key) => state.views.get(key)).filter(Boolean);

function connectionState() {
  const keys = ["", ...state.selectedProjects];
  const states = keys.map((k) => state.feedState.get(k) || "connecting");
  if (states.some((s) => s === "offline")) return "offline";
  if (states.every((s) => s === "live")) return "live";
  return "connecting";
}

// 件数はサーバーの ProjectSummary を正とする。Overview が無いときだけ画面の nodes から数える
function headerCounts() {
  if (!state.selectedProjects.length) return sumCounts(projects().map((p) => p.counts));
  const summaries = projects().filter((p) => state.selectedProjects.includes(p.key));
  if (summaries.length === state.selectedProjects.length) return sumCounts(summaries.map((p) => p.counts));
  return sumCounts(selectedViews().map((view) => countProject(view, state.dismissed)));
}

const ctx = {
  get dismissed() { return state.dismissed; },
  get expandedArchive() { return state.expandedArchive; },
  get selectedScope() { return state.selectedScope; },
  get selectedNode() { return state.selectedNode; },
  knownEdges: state.knownEdges, knownNodes: state.knownNodes, fresh: state.fresh, zoom: state.zoom, orbSlots: new Map(),
  expandedRounds: state.expandedRounds, hiddenTurns: state.hiddenTurns, factsOpen: state.factsOpen, chatView: state.chatView,
  maxWidth: 0, projectName: "",
  confirm: (text) => window.confirm(text),
  onOpen: (key, additive) => openProject(key, additive),
  onSelect: (scope, nodeId) => {
    state.selectedScope = scope.id;
    state.selectedNode = nodeId;
    state.factsOpen.value = false;
    render();
  },
  onToggleDismiss: (scope, nodeId) => {
    const key = dismissKey(scope.id, nodeId);
    if (state.dismissed.has(key)) state.dismissed.delete(key);
    else { state.dismissed.add(key); state.expandedArchive.delete(scope.id); }
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...state.dismissed]));
    previousCanvas = "";
    render();
  },
  onToggleArchive: (scope) => {
    if (state.expandedArchive.has(scope.id)) state.expandedArchive.delete(scope.id); else state.expandedArchive.add(scope.id);
    previousCanvas = "";
    render();
  },
  onAction: async (body) => {
    const repo = projectKeyOf(state.selectedScope) || state.selectedProjects[0] || "";
    const message = await postAction({ repo, ...body });
    // 動かし直したノードは隠し設定を外す
    if (["approve", "retry"].includes(body.action) && body.nodeId && state.selectedScope) {
      if (state.dismissed.delete(dismissKey(state.selectedScope, body.nodeId))) localStorage.setItem(DISMISS_KEY, JSON.stringify([...state.dismissed]));
    }
    render();
    return message;
  },
  onHideTurn: async (scope, turnId) => {
    // 先に画面から外し、サーバに記録できなければ戻す
    const key = `${scope.id}::${turnId}`;
    state.hiddenTurns.add(key);
    previousDetail = "";
    render();
    const message = await postAction({ repo: projectKeyOf(scope.id), action: "hide_turn", sessionId: scope.sessionId, turnId });
    if (/^Failed/.test(message)) { state.hiddenTurns.delete(key); previousDetail = ""; render(); }
  },
};

// Overview と Project ページの切り替え。null で Overview へ戻す
function openProject(key, additive = false) {
  const keys = additive
    ? state.selectedProjects.includes(key) ? state.selectedProjects.filter((k) => k !== key) : [...state.selectedProjects, key]
    : key ? [key] : [];
  state.selectedProjects = [...new Set(keys)];
  if (state.selectedProjects.length) localStorage.setItem(PROJECT_KEY, JSON.stringify(state.selectedProjects)); else localStorage.removeItem(PROJECT_KEY);
  const scope = currentScope();
  if (!scope || !state.selectedProjects.includes(projectKeyOf(scope.id))) { state.selectedScope = null; state.selectedNode = null; }
  syncFeeds();
  previousCanvas = "";
  previousDetail = "";
  render(true);
}

// 開いているプロジェクトの分だけ feed を持つ。Overview の feed は常に持つ
function syncFeeds() {
  const wanted = new Set(["", ...state.selectedProjects]);
  for (const [key, feed] of state.feeds) if (!wanted.has(key)) { feed.close(); state.feeds.delete(key); state.feedState.delete(key); state.views.delete(key); }
  for (const key of wanted) {
    if (state.feeds.has(key)) continue;
    state.feeds.set(key, openFeed(key, {
      onData: (data) => {
        if (key) state.views.set(key, data); else state.overview = data;
        state.updatedAt = data.updatedAt || new Date().toISOString();
        render();
      },
      onState: (s) => { state.feedState.set(key, s); renderHead(); },
    }));
  }
}

function pickDefaultScope() {
  if (currentScope()) return;
  const scopes = selectedViews().flatMap(scopesOf);
  const live = scopes.find((s) => s.kind === "session" && s.status !== "ended" && s.status !== "lost") || scopes[0];
  state.selectedScope = live ? live.id : null;
  state.selectedNode = null;
}

function renderHead() {
  renderHeader(document, {
    projects: projects(), selected: state.selectedProjects, counts: headerCounts(),
    usage: state.selectedProjects.length ? (selectedViews()[0] || {}).usage || (state.overview || {}).usage : (state.overview || {}).usage,
    connection: connectionState(), updatedAt: state.updatedAt,
  }, ctx);
}

function renderCanvas(enter) {
  if (!state.selectedProjects.length) {
    previousCanvas = "";
    renderOverview(canvas, state.overview, ctx);
    return;
  }
  canvas.classList.remove("overview");
  ctx.orbSlots.clear();
  ctx.maxWidth = Math.min(CANVAS_MAX, Math.max(360, canvas.clientWidth - CANVAS_MARGIN));
  const signature = JSON.stringify([state.selectedProjects, selectedViews(), state.selectedScope, state.selectedNode, [...state.dismissed], [...state.expandedArchive], ctx.maxWidth]);
  if (signature === previousCanvas && !enter) return;
  previousCanvas = signature;
  const view = el("div", undefined, "project-view" + (enter ? " enter" : ""));
  for (const key of state.selectedProjects) {
    const data = state.views.get(key);
    if (data) { view.append(buildProjectSection(data, ctx)); continue; }
    const summary = projects().find((p) => p.key === key);
    const section = el("section", undefined, "project");
    section.append(el("h2", summary ? summary.name : key), el("p", "Loading…", "empty"));
    view.append(section);
  }
  const scrollTop = canvas.scrollTop;
  canvas.replaceChildren(view);
  canvas.scrollTop = scrollTop;
  for (const holder of canvas.querySelectorAll(".graph-holder")) if (holder.startSparks) holder.startSparks();
}

function renderAside() {
  if (!state.selectedProjects.length) {
    if (previousDetail !== "overview") { aside.replaceChildren(el("p", "Open a project to see its sessions", "empty")); previousDetail = "overview"; }
    return;
  }
  pickDefaultScope();
  const scope = currentScope();
  const signature = JSON.stringify([state.selectedScope, state.selectedNode, scope, [...state.hiddenTurns]]);
  if (signature === previousDetail) return;
  previousDetail = signature;
  const view = state.views.get(projectKeyOf(state.selectedScope));
  ctx.projectName = view ? view.project.name : "";
  renderDetail(aside, scope, state.selectedNode, ctx);
}

function render(enter = false) {
  // 保存したプロジェクトが消えていれば Overview へ戻す
  if (state.overview && state.selectedProjects.length) {
    const alive = state.selectedProjects.filter((key) => projects().some((p) => p.key === key));
    if (alive.length !== state.selectedProjects.length) { openProject(null); for (const key of alive) openProject(key, true); return; }
  }
  renderCanvas(enter);
  renderAside();
  renderHead();
}

// Overview へ戻る近道
document.addEventListener("keydown", (ev) => {
  const typing = ev.target instanceof Element && ev.target.closest("input, textarea");
  if (ev.key === "Escape" && state.selectedProjects.length && !typing) openProject(null);
});

setupSplitter(document, localStorage, () => { previousCanvas = ""; render(); });
syncFeeds();
render();
