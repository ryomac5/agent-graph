// 操作の結果は画面右下のトーストに出す。10 秒かクリックで消え、新しいものを先頭に積む
import { el } from "./dom.js";

const NOTICE_MS = 10000;
const NOTICE_MAX = 3;
const NOTICE_FADE_MS = 150;

export function toast(text) {
  const host = globalThis.document.getElementById("toasts");
  if (!host) return null;
  const message = String(text == null ? "" : text);
  const node = el("div", message, message.startsWith("Failed") ? "toast failed" : "toast");
  let timer = 0;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    node.classList.remove("show");
    setTimeout(() => node.remove(), NOTICE_FADE_MS);
  };
  node.addEventListener("click", close);
  timer = setTimeout(close, NOTICE_MS);
  host.insertBefore(node, host.firstChild);
  const show = () => node.classList.add("show");
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(show); else show();
  while (host.children.length > NOTICE_MAX) host.removeChild(host.lastChild);
  return node;
}
