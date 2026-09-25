// 上から下の段組み。root を最上段に置き、層が深いほど下へ伸びる。DOM に触れない。

export const ROOT_D = 88;
export const CHILD_D = 96;
export const GRAPH_COL = 34;
export const GRAPH_ROW = 62;
// 同じ層を折り返したときの副段の間隔
export const GRAPH_SUBROW = 26;
export const GRAPH_PAD = 24;
export const CHIP_W = 72, CHIP_H = 30, CHIP_GAP = 18;
export const BACK_BULGE = 46;
export const ARCHIVE_ID = "__archive";

export const nodeBox = (node) => (node.kind === "root" ? { w: ROOT_D, h: ROOT_D } : node.kind === "archive" ? { w: CHIP_W, h: CHIP_H } : { w: CHILD_D, h: CHILD_D });
export const isForward = (edge) => edge.kind !== "return";

// 辺は 3 次ベジェ 1 本。制御点は縦の隔たりの 40% に置き、戻りの辺だけ横へ膨らませる
const EDGE_BEND = 0.4;
export function edgeCurve(x1, y1, x2, y2, bulge = 0) {
  const c = (y2 - y1) * EDGE_BEND;
  return `M${x1},${y1} C${x1 + bulge},${y1 + c} ${x2 + bulge},${y2 - c} ${x2},${y2}`;
}
// 上の曲線の t=0.5。制御点が対称なので端点の中点に膨らみの 3/4 を足した位置になる
export function edgeMid(x1, y1, x2, y2, bulge = 0) {
  return { x: (x1 + x2) / 2 + bulge * 0.75, y: (y1 + y2) / 2 };
}
// 上の曲線の任意の t。ラベルは届く先の近くに置くと、根から出る多くの辺で重ならない
export function edgePoint(x1, y1, x2, y2, bulge = 0, t = 0.5) {
  const c = (y2 - y1) * EDGE_BEND;
  const u = 1 - t;
  const bx = (p0, p1, p2, p3) => u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  return { x: bx(x1, x1 + bulge, x2 + bulge, x2), y: bx(y1, y1 + c, y2 - c, y2) };
}

// 層 = 前向きの辺で辿った最長路。root が無い planner のグラフは入る辺が無い node を最上段にする
export function depthsOf(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const forward = edges.filter((e) => isForward(e) && ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const hasRoot = nodes.some((n) => n.kind === "root");
  const incoming = new Set(forward.map((e) => e.to));
  const depth = new Map(nodes.map((n) => [n.id, n.kind === "root" ? 0 : hasRoot ? 1 : incoming.has(n.id) ? 1 : 0]));
  for (let i = 0; i < nodes.length; i++) {
    let changed = false;
    for (const e of forward) {
      const d = depth.get(e.from) + 1;
      if (d > depth.get(e.to) && d <= nodes.length) { depth.set(e.to, d); changed = true; }
    }
    if (!changed) break;
  }
  return { depth, forward };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// 段組み。maxWidth を超える層は折り返す。入力順に依らず同じ結果を返す
export function layoutGraph(view, options = {}) {
  const maxWidth = Math.max(0, Number(options.maxWidth) || 0);
  const nodes = view.nodes.filter((n) => n.kind !== "archive");
  const chip = view.nodes.find((n) => n.kind === "archive");
  const { depth, forward } = depthsOf(nodes, view.edges);
  const ids = new Set(view.nodes.map((n) => n.id));
  const edges = view.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  const layers = [];
  for (const n of nodes) (layers[depth.get(n.id)] ||= []).push(n);
  const rows = layers.filter(Boolean).map((layer) => [...layer].sort(byId));
  // 親の並びに合わせて子を並べる。同じ親の子は id 順
  const order = new Map();
  rows.forEach((layer, i) => {
    if (i > 0) {
      layer.sort((a, b) => {
        const pa = Math.min(...forward.filter((e) => e.to === a.id).map((e) => order.get(e.from) ?? 1e9), 1e9);
        const pb = Math.min(...forward.filter((e) => e.to === b.id).map((e) => order.get(e.from) ?? 1e9), 1e9);
        return pa - pb || byId(a, b);
      });
    }
    layer.forEach((n, j) => order.set(n.id, j));
  });

  const rowWidth = (layer) => layer.reduce((w, n) => w + nodeBox(n).w, 0) + (layer.length - 1) * GRAPH_COL;
  const rowHeight = (layer) => Math.max(...layer.map((n) => nodeBox(n).h));
  // 折り返し。1 段に置ける数は幅から決め、少なくとも 3 つは並べる
  const inner = Math.max(0, maxWidth - GRAPH_PAD * 2);
  const perRow = maxWidth ? Math.max(3, Math.floor((inner + GRAPH_COL) / (CHILD_D + GRAPH_COL))) : Infinity;
  const bands = rows.map((layer) => {
    if (layer.length <= perRow) return [layer];
    const chunks = [];
    const count = Math.ceil(layer.length / perRow);
    const size = Math.ceil(layer.length / count);
    for (let i = 0; i < layer.length; i += size) chunks.push(layer.slice(i, i + size));
    return chunks;
  });
  const contentWidth = Math.max(1, ...bands.flat().map(rowWidth));
  let width = GRAPH_PAD * 2 + contentWidth;
  const pos = new Map();
  let cursorY = GRAPH_PAD;
  bands.forEach((subrows, bandIndex) => {
    subrows.forEach((layer, subIndex) => {
      const h = rowHeight(layer);
      let x = GRAPH_PAD + (contentWidth - rowWidth(layer)) / 2;
      for (const n of layer) {
        const box = nodeBox(n);
        pos.set(n.id, { x, y: cursorY + (h - box.h) / 2, w: box.w, h: box.h });
        x += box.w + GRAPH_COL;
      }
      cursorY += h + (subIndex < subrows.length - 1 ? GRAPH_SUBROW : 0);
    });
    if (bandIndex < bands.length - 1) cursorY += GRAPH_ROW;
  });
  const height = cursorY + GRAPH_PAD;
  if (chip) {
    const root = nodes.find((n) => n.kind === "root");
    const anchor = (root && pos.get(root.id)) || { x: GRAPH_PAD, y: GRAPH_PAD, w: ROOT_D, h: ROOT_D };
    pos.set(chip.id, { x: anchor.x + anchor.w + CHIP_GAP, y: anchor.y + (anchor.h - CHIP_H) / 2, w: CHIP_W, h: CHIP_H });
    width = Math.max(width, anchor.x + anchor.w + CHIP_GAP + CHIP_W + GRAPH_PAD);
  }
  return { pos, edges, width, height, rows: bands.flat().map((layer) => layer.map((n) => n.id)) };
}

// 戻りの辺の膨らむ向き。左端に寄ったときは右へ逃がす
export function backBulge(x1, x2, width) {
  return BACK_BULGE * (Math.min(x1, x2) - BACK_BULGE < GRAPH_PAD ? 1 : (x1 + x2) / 2 < width / 2 ? -1 : 1);
}

// 枠に収める拡大率。図が枠より広いときだけ縮める
export function fitScale(width, height, boxWidth, boxHeight, min = 0.4) {
  if (!width || !height || !boxWidth) return 1;
  const sx = boxWidth / width;
  const sy = boxHeight ? boxHeight / height : 1;
  return Math.max(min, Math.min(1, sx, sy));
}
