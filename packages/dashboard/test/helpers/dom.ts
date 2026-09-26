// 描画のテスト用の小さな DOM。ui/ が使う API だけを持ち、文字列に直せる
type Listener = (event: unknown) => void;

class StyleMap {
  private props = new Map<string, string>();
  width = "";
  setProperty(name: string, value: string): void { this.props.set(name, value); }
  toString(): string {
    const parts = [...this.props.entries()].map(([k, v]) => `${k}:${v}`);
    if (this.width) parts.push(`width:${this.width}`);
    return parts.join(";");
  }
}

class ClassList {
  private owner: FakeElement;
  constructor(owner: FakeElement) { this.owner = owner; }
  private get set(): Set<string> { return new Set(this.owner.className.split(/\s+/).filter(Boolean)); }
  private write(set: Set<string>): void { this.owner.className = [...set].join(" "); }
  add(...names: string[]): void { const s = this.set; for (const n of names) s.add(n); this.write(s); }
  remove(...names: string[]): void { const s = this.set; for (const n of names) s.delete(n); this.write(s); }
  contains(name: string): boolean { return this.set.has(name); }
  toggle(name: string, force?: boolean): boolean {
    const s = this.set;
    const on = force ?? !s.has(name);
    if (on) s.add(name); else s.delete(name);
    this.write(s);
    return on;
  }
}

export class FakeText {
  parentNode: FakeElement | null = null;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent(): string { return this.data; }
  toString(): string { return this.data; }
}

export class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  childNodes: (FakeElement | FakeText)[] = [];
  parentNode: FakeElement | null = null;
  style = new StyleMap();
  classList = new ClassList(this);
  listeners = new Map<string, Listener[]>();
  title = "";
  type = "";
  hidden = false;
  open = false;
  disabled = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  tagName: string;
  namespace: string;
  constructor(tagName: string, namespace = "") { this.tagName = tagName; this.namespace = namespace; }

  get id(): string { return this.attributes.get("id") ?? ""; }
  set id(value: string) { this.attributes.set("id", value); }
  get className(): string { return this.attributes.get("class") ?? ""; }
  set className(value: string) { this.attributes.set("class", value); }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get firstChild(): FakeElement | FakeText | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeElement | FakeText | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); if (value !== "") this.append(new FakeText(value)); }

  setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: Listener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name)!.push(listener);
  }
  dispatch(name: string, event: unknown = {}): void { for (const l of this.listeners.get(name) ?? []) l(event); }
  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const raw of nodes) {
      const node = typeof raw === "string" ? new FakeText(raw) : raw;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
      if (node instanceof FakeElement) this.children.push(node);
    }
  }
  insertBefore(node: FakeElement, ref: FakeElement | FakeText | null): void {
    if (!ref) { this.append(node); return; }
    node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
    this.children = this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  removeChild(node: FakeElement | FakeText): void {
    this.childNodes = this.childNodes.filter((c) => c !== node);
    this.children = this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
    node.parentNode = null;
  }
  remove(): void { this.parentNode?.removeChild(this); }
  replaceChildren(...nodes: (FakeElement | FakeText)[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.children = [];
    this.append(...nodes);
  }
  matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    return this.tagName === selector;
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeElement): void => { for (const c of node.children) { if (c.matches(selector)) found.push(c); walk(c); } };
    walk(this);
    return found;
  }
  toString(): string {
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    const extra = [this.title ? ` title="${this.title}"` : "", this.hidden ? " hidden" : "", this.open ? " open" : "", this.disabled ? " disabled" : ""].join("");
    const style = this.style.toString();
    return `<${this.tagName}${attrs}${extra}${style ? ` style="${style}"` : ""}>${this.childNodes.map(String).join("")}</${this.tagName}>`;
  }
}

export class FakeDocument {
  documentElement = new FakeElement("html");
  body = new FakeElement("body");
  title = "";
  constructor() { this.documentElement.append(this.body); }
  createElement(tag: string): FakeElement { return new FakeElement(tag); }
  createElementNS(ns: string, tag: string): FakeElement { return new FakeElement(tag, ns); }
  getElementById(id: string): FakeElement | null { return this.documentElement.querySelector(`#${id}`); }
  querySelector(selector: string): FakeElement | null { return this.documentElement.querySelector(selector); }
}

// index.html と同じ骨組み。ヘッダーの描画がここに書く
export function installDocument(): FakeDocument {
  const doc = new FakeDocument();
  const head = new FakeElement("div"); head.className = "head-main";
  for (const id of ["project-bar", "project-count", "summary", "connection", "updated"]) { const e = new FakeElement("span"); e.id = id; head.append(e); }
  const sub = new FakeElement("div"); sub.id = "head-sub";
  const usage = new FakeElement("div"); usage.id = "usage"; sub.append(usage);
  const canvas = new FakeElement("div"); canvas.id = "canvas";
  const aside = new FakeElement("aside"); aside.id = "detail";
  const toasts = new FakeElement("div"); toasts.id = "toasts";
  doc.body.append(head, sub, canvas, aside, toasts);
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}
