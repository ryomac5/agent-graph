// 有向グラフの描画。root → 子を上から下へ。手書きの SVG と foreignObject で丸を描く
import { familyOf, fitWords, kindTitle, modelLabel, roleLabel, statusClass, statusLabel } from "../lib/format.js";
import { ARCHIVE_ID, backBulge, edgeCurve, edgePoint, layoutGraph } from "../lib/layout.js";
import { diffKnown, dismissKey, isDismissable, visibleView } from "../lib/visible.js";
import { XHTML_NS, button, el, keyActivate, reducedMotion, svgEl } from "./dom.js";

// 光の粒が辺を渡る時間と、届いた先が強く灯る時間。CSS の node-arrive と合わせる
const SPARK_MS = 750, LIT_MS = 600;
const FRESH_MS = 4000;
// 段が枠の 1.4 倍までなら折り返さず縮めて出す。それより広い段は折り返す
const WRAP_SLACK = 1.4;
// 前向きの辺のラベルは届く先の近くに置く。隣り合う子で高さを互い違いにして重ねない
const LABEL_T = [0.58, 0.72, 0.86];
// 戻りの辺のラベルは親の近く（子から 82%）に置く。前向きの辺のラベルは子の近くなので重ならない
const BACK_LABEL_T = 0.82;
// ノードに触れたとき、出る辺の文字を出すのはこの本数まで
const HOT_OUT_MAX = 3;
// ラベルの箱。中身は文字に合わせて縮み、本文だけを省略する。向きの語は切らない
const LABEL_W = 260, LABEL_H = 22;
const CHIP_DOTS = 3, CHIP_DOT_GAP = 10, CHIP_PAD = 9;
const ORB_STATUS_CLASS = { running: "on-running", waiting: "on-waiting", failed: "on-failed", done: "on-done", ended: "on-ended", planned: "on-planned" };
const FAMILY_WORD = { anthropic: "Claude", openai: "Codex" };
const edgeKey = (e) => e.id || `${e.from}>${e.to}:${e.kind || "delegate"}`;

function edgeLabel(text, direction, mid) {
  const holder = svgEl("foreignObject", { x: mid.x - LABEL_W / 2, y: mid.y - LABEL_H / 2, width: LABEL_W, height: LABEL_H, "pointer-events": "none" });
  const box = el("div", undefined, "edge-label");
  box.setAttribute("xmlns", XHTML_NS);
  const span = el("span", undefined, "edge-pill");
  if (text) span.append(el("span", text, "txt"));
  if (direction) span.append(el("span", direction, "dir"));
  box.append(span);
  holder.append(box);
  return holder;
}

// 向きの 1 語。系統が違うときだけ添える
export function directionWord(edge, from, to) {
  const a = edge.fromFamily || familyOf(from), b = edge.toFamily || familyOf(to);
  if (!a || !b || a === b) return "";
  return `${FAMILY_WORD[a] || a} → ${FAMILY_WORD[b] || b}`;
}

function modelLines(orb, label, className) {
  const fit = fitWords(label);
  if (!fit.lines.length) return;
  const span = el("span", undefined, `${className}${fit.lines.length > 1 ? " two" : ""}${fit.size ? ` ${fit.size}` : ""}`);
  fit.lines.forEach((line, i) => { if (i) span.append(el("br")); span.append(el("span", line)); });
  orb.append(span);
}

function buildOrb(node, selected) {
  const cls = statusClass(node.status);
  const orb = el("div", undefined, ["orb", node.kind === "root" ? "orb-root" : "orb-node", ORB_STATUS_CLASS[cls] || "", selected ? "selected" : ""].filter(Boolean).join(" "));
  orb.setAttribute("xmlns", XHTML_NS);
  const title = kindTitle(node);
  const sub = modelLabel(node.model) || (node.kind === "root" ? "" : node.executor || "");
  const role = node.kind === "root" ? "" : roleLabel(node);
  orb.title = [node.title, statusLabel(node.status), sub].filter(Boolean).join(" · ");
  orb.append(el("strong", title, "orb-name"));
  modelLines(orb, sub || (node.kind === "root" ? "?" : ""), "orb-live");
  if (role) orb.append(el("span", role, "orb-role"));
  return orb;
}

function buildChip(scope, node, p, expanded, ctx) {
  const chip = svgEl("g", { class: "chip" + (expanded ? " on" : ""), transform: `translate(${p.x},${p.y})`, role: "button", tabindex: 0, "aria-label": node.title });
  chip.append(svgEl("rect", { width: p.w, height: p.h, rx: 15 }));
  const shown = Math.min(node.count, CHIP_DOTS);
  for (let i = 0; i < shown; i++) chip.append(svgEl("circle", { class: "chip-dot", cx: CHIP_PAD + i * CHIP_DOT_GAP, cy: p.h / 2, r: 3 }));
  if (node.count > CHIP_DOTS) chip.append(svgEl("text", { class: "chip-more", x: CHIP_PAD + shown * CHIP_DOT_GAP, y: p.h / 2 + 4, "text-anchor": "middle" }, "+"));
  chip.append(svgEl("title", {}, node.title));
  const toggle = () => ctx.onToggleArchive(scope);
  chip.addEventListener("click", toggle);
  keyActivate(chip, toggle);
  return chip;
}

// ホイールで拡大、ドラッグで移動、ダブルクリックで全体表示。viewBox を動かすだけで描き直さない
function attachZoom(holder, svg, scope, ctx, full) {
  const state = ctx.zoom.get(scope.id) || { ...full };
  const apply = () => svg.setAttribute("viewBox", `${state.x} ${state.y} ${state.w} ${state.h}`);
  apply();
  const remember = () => { ctx.zoom.set(scope.id, { ...state }); };
  const isFit = () => state.w === full.w && state.h === full.h && state.x === full.x && state.y === full.y;
  holder.addEventListener("wheel", (ev) => {
    if (!ev.ctrlKey && !ev.metaKey && Math.abs(ev.deltaY) < 1) return;
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = state.x + ((ev.clientX - rect.left) / rect.width) * state.w;
    const py = state.y + ((ev.clientY - rect.top) / rect.height) * state.h;
    const factor = Math.exp(ev.deltaY * 0.0015);
    const w = Math.min(full.w * 3, Math.max(full.w * 0.25, state.w * factor));
    const h = w * (full.h / full.w);
    state.x = px - ((px - state.x) / state.w) * w;
    state.y = py - ((py - state.y) / state.h) * h;
    state.w = w; state.h = h;
    apply(); remember();
  }, { passive: false });
  let drag = null;
  holder.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest(".node, .chip, .dismiss")) return;
    drag = { x: ev.clientX, y: ev.clientY, vx: state.x, vy: state.y };
    holder.setPointerCapture(ev.pointerId);
    holder.classList.add("panning");
  });
  holder.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    state.x = drag.vx - ((ev.clientX - drag.x) / rect.width) * state.w;
    state.y = drag.vy - ((ev.clientY - drag.y) / rect.height) * state.h;
    apply();
  });
  const stop = () => { if (!drag) return; drag = null; holder.classList.remove("panning"); remember(); };
  holder.addEventListener("pointerup", stop);
  holder.addEventListener("pointercancel", stop);
  holder.addEventListener("dblclick", (ev) => {
    if (ev.target.closest(".node, .chip")) return;
    Object.assign(state, full);
    apply();
    ctx.zoom.delete(scope.id);
  });
  return isFit;
}

// scope は session か planner のグラフ。nodes と edges は契約の NodeDetail と EdgeDetail
export function renderGraph(scope, ctx) {
  const dismissed = ctx.dismissed || new Set();
  const expanded = !!(ctx.expandedArchive && ctx.expandedArchive.has(scope.id));
  const view = visibleView(scope, dismissed, expanded);
  const { pos, edges, width, height, rows } = layoutGraph(view, { maxWidth: ctx.maxWidth ? ctx.maxWidth * WRAP_SLACK : 0 });
  const column = new Map(rows.flatMap((row) => row.map((id, i) => [id, i])));
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const knownEdges = diffKnown(ctx.knownEdges.get(scope.id), scope.edges.map(edgeKey));
  ctx.knownEdges.set(scope.id, knownEdges.known);
  const knownNodes = diffKnown(ctx.knownNodes.get(scope.id), scope.nodes.map((n) => n.id));
  ctx.knownNodes.set(scope.id, knownNodes.known);
  const now = Date.now();
  for (const id of knownNodes.fresh) ctx.fresh.set(`${scope.id}/${id}`, now + FRESH_MS);
  for (const [key, until] of ctx.fresh) if (until < now) ctx.fresh.delete(key);
  const motion = !reducedMotion();

  // 枠に収める。折り返しで大抵は収まるが、収まらなければ縮めて出す
  const shownWidth = ctx.maxWidth ? Math.min(width, ctx.maxWidth) : width;
  const shownHeight = Math.round(height * (shownWidth / width));
  const svg = svgEl("svg", { width: shownWidth, height: shownHeight, viewBox: `0 0 ${width} ${height}`, class: "graph", role: "img", "aria-label": `${scope.name} graph` });
  const defs = svgEl("defs");
  const ARROWS = { arrow: "var(--line)", "arrow-run": "var(--running)", "arrow-sel": "var(--text)" };
  for (const [id, fill] of Object.entries(ARROWS)) {
    const marker = svgEl("marker", { id: `${id}-${scope.id}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto" });
    marker.append(svgEl("path", { d: "M0,0 L10,5 L0,10 z", fill }));
    defs.append(marker);
  }
  svg.append(defs);
  const arrow = (id) => `url(#${id}-${scope.id})`;
  const selectedId = ctx.selectedScope === scope.id ? ctx.selectedNode : null;
  // 触れたノードから引く辺。入る辺は常に、出る辺は少ないときだけ文字を出す。根から出る多くの辺で重ねない
  const edgesByNode = new Map();
  const linkEdge = (id, g, incoming) => { if (!edgesByNode.has(id)) edgesByNode.set(id, { in: [], out: [] }); edgesByNode.get(id)[incoming ? "in" : "out"].push(g); };
  const sparks = [];
  for (const e of edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    if (e.to === ARCHIVE_ID) {
      const y = a.y + a.h / 2;
      svg.append(svgEl("path", { class: "chip-link", d: `M${a.x + a.w},${y} L${b.x},${y}` }));
      continue;
    }
    const sel = selectedId !== null && (e.from === selectedId || e.to === selectedId);
    const from = byId.get(e.from), to = byId.get(e.to);
    const direction = directionWord(e, from, to);
    if (e.kind === "return") {
      // 子の上辺中央 → 親の下辺中央。前向きの辺と重ならないよう左右へ膨らませる
      const x1 = a.x + a.w / 2, y1 = a.y, x2 = b.x + b.w / 2, y2 = b.y + b.h;
      const bulge = backBulge(x1, x2, width);
      const d = edgeCurve(x1, y1, x2, y2, bulge);
      const g = svgEl("g", { class: "edge edge-back" + (sel ? " sel" : ""), "data-edge": edgeKey(e) });
      g.append(svgEl("path", { class: "hit", d }));
      g.append(svgEl("path", { class: "line", d, "marker-end": arrow(sel ? "arrow-sel" : "arrow") }));
      if (e.label || direction) g.append(edgeLabel(e.label || "return", direction, edgePoint(x1, y1, x2, y2, bulge, BACK_LABEL_T)));
      if (knownEdges.fresh.has(edgeKey(e)) && motion) sparks.push({ g, d, target: e.to, family: e.fromFamily || familyOf(from) });
      linkEdge(e.from, g, false); linkEdge(e.to, g, true);
      svg.append(g);
      continue;
    }
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const d = edgeCurve(x1, y1, x2, y2, 0);
    const toRunning = to && statusClass(to.status) === "running";
    const g = svgEl("g", { class: "edge" + (toRunning ? " to-running" : "") + (sel ? " sel" : ""), "data-edge": edgeKey(e) });
    g.append(svgEl("path", { class: "hit", d }));
    g.append(svgEl("path", { class: "line", d, "marker-end": arrow(sel ? "arrow-sel" : toRunning ? "arrow-run" : "arrow") }));
    const text = e.label && e.label !== (to && to.title) ? e.label : (to && to.title) || "";
    if (text || direction) g.append(edgeLabel(text, direction, edgePoint(x1, y1, x2, y2, 0, LABEL_T[(column.get(e.to) || 0) % LABEL_T.length])));
    if (knownEdges.fresh.has(edgeKey(e)) && motion) sparks.push({ g, d, target: e.to, family: e.fromFamily || familyOf(from) });
    linkEdge(e.from, g, false); linkEdge(e.to, g, true);
    svg.append(g);
  }

  const groupById = new Map();
  for (const node of view.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    if (node.kind === "archive") { if (node.count) svg.append(buildChip(scope, node, p, view.expanded, ctx)); continue; }
    const selected = selectedId === node.id;
    const fresh = ctx.fresh.has(`${scope.id}/${node.id}`);
    const g = svgEl("g", {
      class: `node ${statusClass(node.status)}${node.kind === "root" ? " root" : ""}${selected ? " selected" : ""}${fresh ? " fresh" : ""}`,
      transform: `translate(${p.x},${p.y})`, tabindex: 0, role: "button", "data-node": node.id,
      "aria-label": `${node.title || node.id} · ${statusLabel(node.status)}`,
    });
    const holder = svgEl("foreignObject", { x: 0, y: 0, width: p.w, height: p.h });
    const slot = el("div", undefined, "orb-holder");
    slot.setAttribute("xmlns", XHTML_NS);
    slot.append(buildOrb(node, selected));
    if (isDismissable(node)) {
      const dismissedNow = dismissed.has(dismissKey(scope.id, node.id));
      const btn = button(dismissedNow ? "↺" : "×", "dismiss", (ev) => { ev.stopPropagation(); ctx.onToggleDismiss(scope, node.id); });
      btn.title = dismissedNow ? "Restore" : "Hide";
      btn.setAttribute("aria-label", btn.title);
      btn.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); ctx.onToggleDismiss(scope, node.id); } });
      slot.append(btn);
    }
    holder.append(slot);
    g.append(holder);
    const select = () => ctx.onSelect(scope, node.id);
    g.addEventListener("click", select);
    keyActivate(g, select);
    const linked = edgesByNode.get(node.id) || { in: [], out: [] };
    const touching = linked.out.length <= HOT_OUT_MAX ? linked.in.concat(linked.out) : linked.in;
    const mark = (on) => { for (const edge of touching) edge.classList[on ? "add" : "remove"]("hot"); };
    g.addEventListener("mouseenter", () => mark(true));
    g.addEventListener("mouseleave", () => mark(false));
    g.addEventListener("focus", () => mark(true));
    g.addEventListener("blur", () => mark(false));
    groupById.set(node.id, g);
    svg.append(g);
  }

  const holder = el("div", undefined, "graph-holder");
  holder.append(svg, el("span", "wheel: zoom · drag: pan · double-click: fit", "graph-hint"));
  if (typeof holder.addEventListener === "function" && typeof svg.getBoundingClientRect === "function") {
    attachZoom(holder, svg, scope, ctx, { x: 0, y: 0, w: width, h: height });
  }
  // 粒は DOM に入ってから始める。beginElement は time container が要る
  holder.startSparks = () => {
    if (!sparks.length) return;
    requestAnimationFrame(() => {
      for (const { g, d, target, family } of sparks) {
        const spark = svgEl("circle", { class: `spark${family ? ` ${family}` : ""}`, r: 3.5, cx: 0, cy: 0 });
        const motionEl = svgEl("animateMotion", { dur: `${SPARK_MS}ms`, path: d, begin: "indefinite", fill: "remove", repeatCount: "1" });
        spark.append(motionEl);
        g.append(spark);
        try { motionEl.beginElement(); } catch { /* SMIL 非対応 */ }
        setTimeout(() => spark.remove(), SPARK_MS);
        const group = groupById.get(target);
        if (group) {
          setTimeout(() => group.classList.add("lit"), SPARK_MS);
          setTimeout(() => group.classList.remove("lit"), SPARK_MS + LIT_MS);
        }
      }
    });
  };
  return holder;
}
