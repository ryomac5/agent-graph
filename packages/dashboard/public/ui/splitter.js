// 右パネルの幅。ドラッグと矢印キーで変え、ブラウザに記憶する
const KEY = "agent-graph:aside-width";
const STEP = 24;

export function setupSplitter(doc, storage, onChange) {
  const splitter = doc.getElementById("splitter");
  const root = doc.documentElement;
  // 詳細は 320px 以上。左のプロジェクトの一覧とグラフに少なくとも 320px を残す
  const MIN_ASIDE = 320, MIN_CANVAS = 320;
  const navWidth = () => doc.getElementById("workspace-nav")?.getBoundingClientRect().width ?? 0;
  const clamp = (w) => Math.min(Math.max(w, MIN_ASIDE), Math.max(MIN_ASIDE, Math.floor(globalThis.innerWidth - navWidth() - MIN_CANVAS)));
  const apply = (w) => root.style.setProperty("--aside-w", `${clamp(w)}px`);
  const current = () => doc.getElementById("detail").getBoundingClientRect().width;
  const save = () => storage.setItem(KEY, String(Math.round(current())));
  const saved = Number(storage.getItem(KEY));
  if (saved) apply(saved);
  let dragging = false;
  splitter.addEventListener("pointerdown", (ev) => {
    dragging = true;
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add("dragging");
    doc.body.classList.add("resizing");
  });
  splitter.addEventListener("pointermove", (ev) => { if (dragging) apply(globalThis.innerWidth - ev.clientX - 4); });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
    doc.body.classList.remove("resizing");
    save();
    onChange();
  };
  splitter.addEventListener("pointerup", stop);
  splitter.addEventListener("pointercancel", stop);
  splitter.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") apply(current() + STEP);
    else if (ev.key === "ArrowRight") apply(current() - STEP);
    else return;
    ev.preventDefault();
    save();
    onChange();
  });
  globalThis.addEventListener("resize", () => { const w = Number(storage.getItem(KEY)); if (w) apply(w); onChange(); });
}
