import { applySnapshot, applyDelegation, edgeDirection, layout } from "./model.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const EMPTY_GRAPH = { nodes: [], edges: [] };
const repoSelect = document.querySelector("#repo");
const graphElement = document.querySelector("#graph");
const emptyElement = document.querySelector("#empty");
const detailsElement = document.querySelector("#details");
const connectionElement = document.querySelector("#connection");
const countElement = document.querySelector("#count");
let state = EMPTY_GRAPH;
let selectedId = null;
let events = null;

function svg(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function familyOf(node) {
  if (node.family === "anthropic" || node.executor === "claude") return "anthropic";
  if (node.family === "openai" || node.executor === "codex") return "openai";
  return "other";
}

function showDetails() {
  detailsElement.replaceChildren();
  const node = state.nodes.find((item) => item.id === selectedId);
  if (!node) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "ノードを選択すると詳細を表示します。";
    detailsElement.append(hint);
    return;
  }
  const title = document.createElement("h3");
  title.className = "detail-title";
  title.textContent = node.title;
  const list = document.createElement("dl");
  for (const [label, value] of Object.entries({ ID: node.id, 種類: node.kind, 役割: node.role, 状態: node.status, 実行: node.executor, モデル: node.model, 系統: node.family, 開始: node.startedAt, 終了: node.endedAt })) {
    if (value == null || value === "") continue;
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }
  detailsElement.append(title, list);
}

function drawGraph() {
  const positions = layout(state).nodes;
  const points = new Map(positions.map((point) => [point.id, point]));
  const width = Math.max(800, ...positions.map((point) => point.x + 170));
  const height = Math.max(520, ...positions.map((point) => point.y + 100));
  graphElement.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graphElement.setAttribute("width", width);
  graphElement.setAttribute("height", height);
  graphElement.replaceChildren();
  emptyElement.hidden = state.nodes.length > 0;
  countElement.textContent = `${state.nodes.length} ノード / ${state.edges.length} 辺`;

  const defs = svg("defs");
  for (const [id, color] of [["anthropic", "#b46b43"], ["openai", "#197c75"], ["same", "#65748b"], ["unknown", "#94a3b8"]]) {
    const marker = svg("marker", { id: `arrow-${id}`, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: "auto" });
    marker.append(svg("path", { d: "M0 0 L8 4 L0 8 Z", fill: color }));
    defs.append(marker);
  }
  graphElement.append(defs);
  for (const edge of state.edges) {
    const from = points.get(edge.from);
    const to = points.get(edge.to);
    if (!from || !to) continue;
    const direction = edgeDirection(edge);
    const color = direction === "anthropic→openai" ? "#b46b43" : direction === "openai→anthropic" ? "#197c75" : direction === "same" ? "#65748b" : "#94a3b8";
    const startX = from.x + 100;
    const endX = to.x - 100;
    const path = svg("path", { d: `M${startX} ${from.y} C${startX + 70} ${from.y},${endX - 70} ${to.y},${endX} ${to.y}`, fill: "none", stroke: color, "stroke-width": 2, "marker-end": `url(#arrow-${direction === "anthropic→openai" ? "anthropic" : direction === "openai→anthropic" ? "openai" : direction})` });
    graphElement.append(path);
    const label = svg("text", { x: (startX + endX) / 2, y: (from.y + to.y) / 2 - 12, "text-anchor": "middle", class: "edge-label" });
    label.textContent = `${edge.title ?? "委譲"} · ${direction}`;
    graphElement.append(label);
  }
  for (const point of positions) {
    const node = state.nodes.find((item) => item.id === point.id);
    const family = familyOf(node);
    const color = family === "anthropic" ? "#b46b43" : family === "openai" ? "#197c75" : "#65748b";
    const group = svg("g", { class: "node", tabindex: 0, role: "button", "aria-label": `${node.title} の詳細` });
    group.append(svg("rect", { x: point.x - 100, y: point.y - 36, width: 200, height: 72, rx: 9, fill: "#fff", stroke: selectedId === node.id ? "#1a2332" : color, "stroke-width": selectedId === node.id ? 3 : 2 }));
    const title = svg("text", { x: point.x - 88, y: point.y - 4, fill: "#1a2332", "font-size": 13, "font-weight": 600 });
    title.textContent = node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title;
    const subtitle = svg("text", { x: point.x - 88, y: point.y + 20, fill: color, "font-size": 11 });
    subtitle.textContent = `${node.kind === "session" ? "セッション" : "委譲"} · ${node.executor ?? node.family ?? "未割り当て"} · ${node.status ?? ""}`;
    group.append(title, subtitle);
    group.addEventListener("click", () => { selectedId = node.id; drawGraph(); showDetails(); });
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); group.dispatchEvent(new Event("click")); } });
    graphElement.append(group);
  }
  showDetails();
}

function connect(repo) {
  events?.close();
  events = new EventSource(`/api/events?repo=${encodeURIComponent(repo)}`);
  connectionElement.textContent = "接続中";
  events.addEventListener("open", () => { connectionElement.textContent = "ライブ"; });
  events.addEventListener("error", () => { connectionElement.textContent = "再接続中"; });
  events.addEventListener("snapshot", (event) => {
    if (repoSelect.value !== repo) return;
    state = applySnapshot(EMPTY_GRAPH, JSON.parse(event.data));
    drawGraph();
  });
  events.addEventListener("delegation", (event) => {
    if (repoSelect.value !== repo) return;
    state = applyDelegation(state, JSON.parse(event.data));
    drawGraph();
  });
}

async function selectRepo() {
  const repo = repoSelect.value;
  events?.close();
  events = null;
  state = EMPTY_GRAPH;
  selectedId = null;
  drawGraph();
  if (!repo) return;
  connectionElement.textContent = "読み込み中";
  try {
    const response = await fetch(`/api/graph?repo=${encodeURIComponent(repo)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (repoSelect.value !== repo) return;
    state = applySnapshot(EMPTY_GRAPH, await response.json());
    drawGraph();
    connect(repo);
  } catch (error) {
    connectionElement.textContent = `読込失敗: ${error.message}`;
  }
}

async function loadRepos() {
  try {
    const response = await fetch("/api/repos");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const repos = await response.json();
    repoSelect.replaceChildren(new Option("選択してください", ""));
    for (const repo of repos) repoSelect.add(new Option(repo.name, repo.key));
    if (repos.length) { repoSelect.value = repos[0].key; await selectRepo(); }
  } catch (error) {
    connectionElement.textContent = `読込失敗: ${error.message}`;
  }
}

repoSelect.addEventListener("change", selectRepo);
drawGraph();
loadRepos();
