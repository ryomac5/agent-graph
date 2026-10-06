import { createHash } from "node:crypto";

export const HIGH_ENTROPY_MIN_LENGTH = 20;
export const HIGH_ENTROPY_THRESHOLD = 4;
const HASH_PREFIX_LENGTH = 4;

export interface RedactionRules {
  /** 省略時は既定の検出を全て有効にする。 */
  defaults?: boolean;
  /** 文字列は正規表現の source。全体の一致を伏せる。 */
  patterns?: readonly (string | RegExp)[];
}

export interface RedactionFinding {
  kind: string;
  /** 入力の UTF-16 オフセット。end は範囲に含まない。 */
  start: number;
  end: number;
  marker: string;
}

export interface RedactionRuleError {
  index: number;
  message: string;
}

const KEY_FORMATS: readonly { kind: string; pattern: RegExp }[] = [
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { kind: "openai", pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g },
  { kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])/g },
  { kind: "aws", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g },
  { kind: "google", pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g },
  // 終端のない出力は、続く base64 行（省略記号を含む）まで伏せる。
  { kind: "private-key", pattern: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----(?:[\s\S]*?-----END \1-----|(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/]+={0,2}(?:\.{3}|…)?[ \t]*(?=\r?\n|$))*)/g },
];
const MARKER_PATTERN = /\[REDACTED:[a-z-]+:[0-9a-f]{4}\]/g;
const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PRIVATE/i;
const ENV_PATTERN = /^[ \t]*(?:[+-][ \t]*)?(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"((?:\\[^\r\n]|[^"\\])*)"|'((?:\\[^\r\n]|[^'\\])*)'|([^\r\n]*))/dgm;
const NAMED_VALUE_PATTERN = /(?<![A-Za-z0-9_.-])["']?((?=[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE))[A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"|'((?:\\[^\r\n]|[^'\\\r\n])*)'|([^\s,;\]}]+))/dgi;
const BEARER_PATTERN = /\bBearer[ \t]+([A-Za-z0-9._~+\/-]+=*)/dgi;
const IDENTIFIER_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function compilePattern(pattern: string | RegExp): RegExp {
  return typeof pattern === "string"
    ? new RegExp(pattern, "g")
    : new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/g, "")}g`);
}

export function validateRules(rules: RedactionRules = {}): RedactionRuleError[] {
  const errors: RedactionRuleError[] = [];
  for (const [index, pattern] of (rules.patterns ?? []).entries()) {
    try {
      compilePattern(pattern);
    } catch {
      // 正規表現や入力の本文を検証結果へ複製しない。
      errors.push({ index, message: "不正な正規表現です" });
    }
  }
  return errors;
}

function measureEntropy(value: string): number {
  const counts = new Map<string, number>();
  let length = 0;
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
    length += 1;
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isHighEntropySecret(value: string): boolean {
  return value.length >= HIGH_ENTROPY_MIN_LENGTH
    && !IDENTIFIER_PATTERN.test(value)
    && value.match(MARKER_PATTERN)?.[0] !== value
    && measureEntropy(value) >= HIGH_ENTROPY_THRESHOLD;
}

function classifySecret(value: string): string {
  for (const { kind, pattern } of KEY_FORMATS) {
    const match = new RegExp(pattern.source).exec(value);
    if (match?.index === 0 && match[0].length === value.length) return kind;
  }
  // 文脈や追加規則が違っても同じ値には同じ種類を付ける。
  return "secret";
}

function createMarker(value: string, kind: string): string {
  const hash = createHash("sha256").update(value).digest("hex").slice(0, HASH_PREFIX_LENGTH);
  return `[REDACTED:${kind}:${hash}]`;
}

export function redact(text: string, rules: RedactionRules = {}): {
  text: string;
  findings: RedactionFinding[];
} {
  if (validateRules(rules).length > 0) {
    throw new TypeError("秘匿の規則が不正です。validateRules で検証してください");
  }
  const ranges: { start: number; end: number }[] = [];
  const protectedRanges = Array.from(text.matchAll(MARKER_PATTERN), (match) => ({
    start: match.index, end: match.index + match[0].length,
  }));
  function addRange(start: number, end: number): void {
    if (start < end && !protectedRanges.some((range) => start >= range.start && end <= range.end)) {
      ranges.push({ start, end });
    }
  }
  if (rules.defaults !== false) {
    for (const { pattern } of KEY_FORMATS) {
      for (const match of text.matchAll(pattern)) addRange(match.index, match.index + match[0].length);
    }
    for (const match of text.matchAll(BEARER_PATTERN)) {
      const [start, end] = match.indices![1];
      addRange(start, end);
    }
    for (const [pattern, requireEntropy] of [[ENV_PATTERN, false], [NAMED_VALUE_PATTERN, true]] as const) {
      for (const match of text.matchAll(pattern)) {
        if (!SECRET_NAME_PATTERN.test(match[1])) continue;
        const group = match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
        let [start, end] = match.indices![group];
        if (pattern === ENV_PATTERN && group === 4) {
          const value = text.slice(start, end).replace(/[ \t]+#.*$/, "").trimEnd();
          end = start + value.length;
        }
        const value = text.slice(start, end);
        if (requireEntropy && !isHighEntropySecret(value)) continue;
        addRange(start, end);
      }
    }
  }
  for (const pattern of rules.patterns ?? []) {
    for (const match of text.matchAll(compilePattern(pattern))) {
      addRange(match.index, match.index + match[0].length);
    }
  }
  // 重なる検出をまとめ、部分的な置換で秘密の末尾が残るのを防ぐ。
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const findings: RedactionFinding[] = [];
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of merged) {
    const value = text.slice(start, end);
    const kind = classifySecret(value);
    const marker = createMarker(value, kind);
    findings.push({ kind, start, end, marker });
    parts.push(text.slice(cursor, start), marker);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), findings };
}

/** キーの衝突は #番号で区別する。通常のオブジェクトと配列以外は保持する。 */
export function redactValue(value: unknown, rules: RedactionRules = {}): unknown {
  if (validateRules(rules).length > 0) {
    throw new TypeError("秘匿の規則が不正です。validateRules で検証してください");
  }
  const visited = new WeakMap<object, unknown>();
  function visit(item: unknown, name = ""): unknown {
    if (typeof item === "string") {
      if (rules.defaults !== false && SECRET_NAME_PATTERN.test(name) && isHighEntropySecret(item)) {
        return createMarker(item, classifySecret(item));
      }
      return redact(item, rules).text;
    }
    if (item === null || typeof item !== "object") return item;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return item;
    if (visited.has(item)) return visited.get(item);
    const result: unknown[] | Record<string, unknown> = Array.isArray(item)
      ? new Array(item.length) : Object.create(prototype);
    visited.set(item, result);
    const entries = Object.entries(item).map(([key, child]) => ({ key, child, redactedKey: redact(key, rules).text }));
    const reservedKeys = new Set(entries.map(({ redactedKey }) => redactedKey));
    const usedKeys = new Set<string>();
    for (const { key, child, redactedKey } of entries) {
      let outputKey = redactedKey;
      let suffix = 1;
      // 後続のキーも予約し、衝突による上書きを防ぐ。
      if (usedKeys.has(outputKey)) {
        do {
          outputKey = `${redactedKey}#${suffix++}`;
        } while (reservedKeys.has(outputKey) || usedKeys.has(outputKey));
      }
      usedKeys.add(outputKey);
      Object.defineProperty(result, outputKey, {
        value: visit(child, key), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  return visit(value);
}
