// 未変更の行をそのまま残し、変更した葉だけを書き換える。
interface Entry { path: string; line: number; end: number; comment: string }
function stripComment(line: string): { value: string; comment: string } {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return { value: line.slice(0, i).trim(), comment: line.slice(i) };
  }
  return { value: line.trim(), comment: "" };
}
function parseValue(text: string): unknown {
  let index = 0;
  const space = () => { while (/\s/.test(text[index] ?? "") && index < text.length) index++; };
  function read(): unknown {
    space();
    const c = text[index++];
    if (c === '"' || c === "'") {
      const start = index - 1;
      while (index < text.length) {
        const ch = text[index++];
        if (ch === "\\" && c === '"') index++;
        else if (ch === c) {
          if (c === "'") return text.slice(start + 1, index - 1);
          try { return JSON.parse(text.slice(start, index)); } catch { throw new SyntaxError("Invalid TOML string"); }
        }
      }
      throw new SyntaxError("Unterminated TOML string");
    }
    if (c === "[") {
      const result: unknown[] = [];
      space();
      while (text[index] !== "]") { result.push(read()); space(); if (text[index] !== ",") break; index++; space(); }
      if (text[index++] !== "]") throw new SyntaxError("Invalid TOML array");
      return result;
    }
    if (c === "{") {
      const result: Record<string, unknown> = {};
      space();
      while (text[index] !== "}") {
        const key = /^[A-Za-z_][\w-]*/.exec(text.slice(index))?.[0];
        if (!key) throw new SyntaxError("Invalid inline table");
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new SyntaxError("Invalid TOML key");
        index += key.length; space(); if (text[index++] !== "=") throw new SyntaxError("Invalid inline table");
        if (Object.hasOwn(result, key)) throw new SyntaxError("Duplicate TOML key");
        result[key] = read(); space(); if (text[index] !== ",") break; index++; space();
      }
      if (text[index++] !== "}") throw new SyntaxError("Invalid inline table");
      return result;
    }
    index--;
    const token = /^[^\s,\]}]+/.exec(text.slice(index))?.[0];
    if (!token) throw new SyntaxError("Invalid TOML value");
    index += token.length;
    if (token === "true" || token === "false") return token === "true";
    if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return Number(token);
    throw new SyntaxError("Unsupported TOML value");
  }
  const value = read(); space(); if (index !== text.length) throw new SyntaxError("Invalid TOML value"); return value;
}
function assignPath(root: Record<string, unknown>, path: string[], value: unknown): void {
  let parent = root;
  for (const key of path.slice(0, -1)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new SyntaxError("Invalid TOML key");
    parent[key] ??= {};
    if (!parent[key] || typeof parent[key] !== "object") throw new SyntaxError("Conflicting TOML key");
    parent = parent[key] as Record<string, unknown>;
  }
  const key = path.at(-1)!;
  if (["__proto__", "constructor", "prototype"].includes(key) || Object.hasOwn(parent, key)) throw new SyntaxError("Duplicate or invalid TOML key");
  parent[key] = value;
}
function readDocument(text: string): { value: Record<string, unknown>; entries: Entry[]; lines: string[] } {
  const lines = text.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  const entries: Entry[] = [];
  const tables = new Set<string>();
  let section: string[] = [];
  let target = root;
  let prefix = "";
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    if (!stripped.value) continue;
    const array = /^\[\[([\w.-]+)\]\]$/.exec(stripped.value);
    const table = /^\[([\w.-]+)\]$/.exec(stripped.value);
    if (array || table) {
      section = (array ?? table)![1].split("."); prefix = section.join("."); target = root;
      if (section.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new SyntaxError("Invalid TOML key");
      if (array) {
        let parent = root;
        for (const key of section.slice(0, -1)) { if (!Object.hasOwn(parent, key)) assignPath(parent, [key], {}); parent = parent[key] as Record<string, unknown>; }
        const key = section.at(-1)!;
        if (!Object.hasOwn(parent, key)) assignPath(parent, [key], []);
        const list = parent[key];
        if (!Array.isArray(list)) throw new SyntaxError("Invalid array table");
        target = {}; list.push(target);
        entries.push({ path: prefix, line: i, end: i, comment: stripped.comment });
        section = [];
      } else {
        if (tables.has(prefix)) throw new SyntaxError("Duplicate TOML table");
        tables.add(prefix);
        let parent = root;
        for (const key of section) {
          if (!Object.hasOwn(parent, key)) assignPath(parent, [key], {});
          const child = parent[key];
          if (!child || typeof child !== "object" || Array.isArray(child)) throw new SyntaxError("Conflicting TOML table");
          parent = child as Record<string, unknown>;
        }
        // セクションの存在自体は値を書かず、重複した葉で衝突を検出する。
        entries.push({ path: `@${prefix}`, line: i, end: i, comment: stripped.comment });
      }
      continue;
    }
    const pair = /^([\w.-]+)\s*=\s*(.+)$/.exec(stripped.value);
    if (!pair) throw new SyntaxError(`Invalid TOML at line ${i + 1}`);
    const start = i;
    let raw = pair[2];
    let value: unknown;
    for (;;) {
      try { value = parseValue(raw); break; } catch (error) {
        if (!raw.startsWith("[") || i + 1 >= lines.length) throw error;
        raw += "\n" + stripComment(lines[++i]).value;
      }
    }
    const path = [...section, ...pair[1].split(".")];
    assignPath(target, path, value);
    entries.push({ path: target === root ? path.join(".") : `${prefix}.${pair[1]}`, line: start, end: i, comment: stripped.comment });
  }
  return { value: root, entries, lines };
}
export function parseSettingsToml(text: string, policy = false): Record<string, unknown> {
  const value = readDocument(text).value;
  if (policy && value.review) {
    const review = value.review as Record<string, unknown>;
    if (Object.keys(review).some((key) => key !== "max_round_trips") || Object.hasOwn(value, "maxRoundTrips")) throw new TypeError("Invalid review settings");
    value.maxRoundTrips = review.max_round_trips; delete value.review;
  }
  return value;
}
function serializeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${k} = ${serializeValue(v)}`).join(", ")} }`;
  if (value === null) throw new TypeError("TOML null must be omitted");
  return JSON.stringify(value);
}
export function updateSettingsToml(text: string, patch: Record<string, unknown>, policy = false): string {
  const document = readDocument(text);
  const leaves: Record<string, unknown> = {};
  function flatten(value: Record<string, unknown>, prefix = ""): void {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === "object" && !Array.isArray(child)) flatten(child as Record<string, unknown>, path);
      else leaves[policy && path === "maxRoundTrips" && !Object.hasOwn(document.value, "maxRoundTrips") ? "review.max_round_trips" : path] = child;
    }
  }
  flatten(patch);
  // 同じ値を含む保存要求でも、未変更の配列や注釈は書き換えない。
  for (const [path, value] of Object.entries(leaves)) {
    let original: unknown = document.value;
    for (const key of path.split(".")) {
      original = original && typeof original === "object"
        ? (original as Record<string, unknown>)[key] : undefined;
    }
    if (JSON.stringify(original) === JSON.stringify(value) || value === null && original === undefined) delete leaves[path];
  }
  // インラインテーブルの子だけを更新する場合も、兄弟の値と注釈を残す。
  for (const [path, value] of Object.entries(leaves)) {
    const ancestor = document.entries.find((entry) => !entry.path.startsWith("@") && path.startsWith(`${entry.path}.`));
    if (!ancestor) continue;
    const parts = ancestor.path.split(".");
    let original: unknown = document.value;
    for (const key of parts) original = (original as Record<string, unknown>)[key];
    if (!original || typeof original !== "object" || Array.isArray(original)) throw new TypeError("Conflicting TOML key");
    const replacement = (leaves[ancestor.path] ?? structuredClone(original)) as Record<string, unknown>;
    let parent = replacement;
    const childPath = path.slice(ancestor.path.length + 1).split(".");
    for (const key of childPath.slice(0, -1)) {
      parent[key] ??= {};
      parent = parent[key] as Record<string, unknown>;
    }
    if (value === null) delete parent[childPath.at(-1)!];
    else parent[childPath.at(-1)!] = value;
    delete leaves[path];
    leaves[ancestor.path] = replacement;
  }
  const removed = new Set<number>();
  const replacements = new Map<number, string>();
  const append: string[] = [];
  const additions = new Map<string, string[]>();
  for (const [path, value] of Object.entries(leaves)) {
    const matches = document.entries.filter((entry) => entry.path === path || entry.path.startsWith(`${path}.`));
    for (const entry of matches) for (let i = entry.line; i <= entry.end; i++) removed.add(i);
    const parts = path.split("."); const key = parts.pop()!; const section = parts.join(".");
    // 配列テーブルは同じ形で出力し、既存の policy 読み込みにも合わせる。
    if (Array.isArray(value) && value.some((item) => item && typeof item === "object")) {
      append.push(...value.flatMap((item) => [`[[${path}]]`, ...Object.entries(item).map(([k, v]) => `${k} = ${serializeValue(v)}`)]));
    } else if (value !== null) {
      const existing = matches.length === 1 && matches[0].path === path ? matches[0] : undefined;
      if (existing) {
        const originalKey = /^\s*([\w.-]+)\s*=/.exec(document.lines[existing.line])![1];
        replacements.set(existing.line, `${originalKey} = ${serializeValue(value)}${existing.comment ? ` ${existing.comment}` : ""}`);
      } else {
        const group = additions.get(section) ?? [];
        group.push(`${key} = ${serializeValue(value)}`); additions.set(section, group);
      }
    }
  }
  const insertions = new Map<number, string[]>();
  for (const [section, lines] of additions) {
    const header = document.entries.find((entry) => entry.path === `@${section}`);
    if (header || !section) {
      const next = document.entries.find((entry) => entry.line > (header?.line ?? -1) && /^\s*\[/.test(document.lines[entry.line]));
      const at = next?.line ?? document.lines.length;
      insertions.set(at, [...(insertions.get(at) ?? []), ...lines]);
    } else append.push(`[${section}]`, ...lines);
  }
  const output: string[] = [];
  for (let i = 0; i <= document.lines.length; i++) {
    output.push(...(insertions.get(i) ?? []));
    if (i === document.lines.length) break;
    if (replacements.has(i)) output.push(replacements.get(i)!);
    else if (!removed.has(i)) output.push(document.lines[i]);
  }
  return [...output, ...append, ""].join("\n");
}
