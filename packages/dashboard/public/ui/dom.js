// DOM の小さな助け。document は呼ぶたびに引く。テストでは差し替えられる
export const SVG_NS = "http://www.w3.org/2000/svg";
export const XHTML_NS = "http://www.w3.org/1999/xhtml";

const doc = () => globalThis.document;

export function el(tag, text, className) {
  const node = doc().createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function svgEl(tag, attrs, text) {
  const node = doc().createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(text, className, onClick) {
  const node = el("button", text, className);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

// Enter と Space で click と同じ動きにする
export function keyActivate(node, action) {
  node.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); action(ev); }
  });
}

export const reducedMotion = () =>
  !!globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
