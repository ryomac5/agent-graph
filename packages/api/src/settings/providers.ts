import { randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import type { Policy } from "../../../core/src/assign/policy.ts";
import { getCandidates, ROLES } from "../../../core/src/assign/policy.ts";
import type { Executor } from "../../../core/src/delegate/types.ts";
import type { AvailableModel } from "../../../core/src/settings/index.ts";
import { parseSettingsToml, updateTomlFields } from "./toml.ts";
import { writeAtomic } from "./index.ts";

interface Change { path: string; before: string; after: string; exists: boolean; diff: string }
interface Preview { provider: Executor; changes: Change[]; policy: string }
export interface ProviderPreview { token: string; provider: Executor; files: { path: string; diff: string }[]; mcpCommand?: string }

async function readTarget(path: string): Promise<{ text: string; exists: boolean }> {
  try {
    if (!(await lstat(path)).isFile()) throw new TypeError("Provider settings must be regular files");
    return { text: await readFile(path, "utf8"), exists: true };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", exists: false }; throw error; }
}

// JSON の値の範囲だけを置き換え、未変更の空白とキーの順を保つ。
export function updateJsonFields(text: string, patch: Record<string, string>): string {
  if (!text.trim()) return JSON.stringify(patch, null, 2) + "\n";
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected JSON object");
  const spans = new Map<string, [number, number]>();
  let index = text.indexOf("{") + 1;
  const skip = () => { while (/\s/.test(text[index] ?? "") && index < text.length) index++; };
  const readString = () => {
    const start = index++;
    while (index < text.length) { const c = text[index++]; if (c === "\\") index++; else if (c === '"') break; }
    return JSON.parse(text.slice(start, index)) as string;
  };
  skip();
  while (text[index] !== "}") {
    const key = readString(); skip(); index++; skip();
    const start = index;
    let depth = 0;
    while (index < text.length) {
      const c = text[index];
      if (c === '"') { readString(); continue; }
      if (depth === 0 && (c === "," || c === "}")) break;
      if (c === "{" || c === "[") depth++;
      if (c === "}" || c === "]") depth--;
      index++;
    }
    let end = index; while (/\s/.test(text[end - 1])) end--;
    if (spans.has(key)) throw new TypeError("Duplicate JSON key");
    spans.set(key, [start, end]); skip(); if (text[index] === ",") { index++; skip(); }
  }
  const additions = Object.entries(patch).filter(([key]) => !spans.has(key));
  let output = text;
  const changes = Object.entries(patch).flatMap(([key, entry]) => spans.has(key) ? [{ span: spans.get(key)!, value: JSON.stringify(entry) }] : []);
  for (const { span: [start, end], value } of changes.sort((a, b) => b.span[0] - a.span[0])) output = output.slice(0, start) + value + output.slice(end);
  if (additions.length) {
    const close = output.lastIndexOf("}");
    const body = output.slice(0, close).trimEnd();
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
    output = body + (spans.size ? "," : "") + newline + additions.map(([key, entry]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(entry)}`).join("," + newline) + newline + output.slice(close);
  }
  return output;
}
export function updateAgentModel(text: string, model: string): string {
  const frontmatter = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(text);
  if (!frontmatter) throw new TypeError("Agent frontmatter required");
  const matches = [...frontmatter[2].matchAll(/^model\s*:\s*.*$/gm)];
  if (matches.length !== 1) throw new TypeError("Agent must have one model field");
  const match = matches[0];
  const newline = match[0].endsWith("\r") ? "\r" : "";
  const comment = /\s+#.*$/.exec(match[0].replace(/\r$/, ""))?.[0] ?? "";
  const body = frontmatter[2].slice(0, match.index) + `model: ${JSON.stringify(model)}${comment}${newline}` + frontmatter[2].slice(match.index! + match[0].length);
  return frontmatter[1] + body + frontmatter[3] + text.slice(frontmatter[0].length);
}
function buildDiff(before: string, after: string): string {
  const old = before.split(/\r?\n/); const next = after.split(/\r?\n/);
  let start = 0; while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let endOld = old.length, endNext = next.length;
  while (endOld > start && endNext > start && old[endOld - 1] === next[endNext - 1]) { endOld--; endNext--; }
  return [`@@ -${start + 1},${endOld - start} +${start + 1},${endNext - start} @@`, ...old.slice(start, endOld).map(line => `-${line}`), ...next.slice(start, endNext).map(line => `+${line}`)].join("\n");
}
export class ProviderSettings {
  private previews = new Map<string, Preview>();
  private home: string;
  private mcp: { command: string; args: string[] };
  constructor(home: string, mcp: { command: string; args: string[] }) {
    this.home = home; this.mcp = mcp;
    if (!isAbsolute(home)) throw new TypeError("Provider home must be absolute");
  }
  private async readMcpRegistration(): Promise<{ command: string; args: string[] }> {
    const { text } = await readTarget(join(this.home, ".codex/config.toml"));
    let inside = false;
    const lines: string[] = [];
    let array = false;
    for (const line of text.split(/\r?\n/)) {
      const header = /^\s*\[([^\[\]]+)\]/.exec(line);
      if (header && !array) inside = header[1].replace(/["']/g, "") === "mcp_servers.agent-graph";
      if (!inside) continue;
      if (array || /^\s*(?:command|args)\s*=/.test(line)) {
        lines.push(line);
        array = /^\s*args\s*=\s*\[/.test(line) && !/\]\s*(?:#.*)?$/.test(line) || array && !/\]\s*(?:#.*)?$/.test(line);
      }
    }
    const registration = parseSettingsToml(lines.join("\n"));
    if (typeof registration.command === "string" && Array.isArray(registration.args) && registration.args.every(arg => typeof arg === "string")) return { command: registration.command, args: registration.args };
    return this.mcp;
  }
  async preview(provider: Executor, policy: Policy, models: AvailableModel[] = []): Promise<ProviderPreview> {
    if (!["claude", "codex", "antigravity"].includes(provider)) throw new TypeError("Invalid provider");
    const changes: Change[] = [];
    const add = async (path: string, transform: (text: string) => string) => {
      const { text: before, exists } = await readTarget(path);
      const after = transform(before);
      if (before !== after) changes.push({ path, before, after, exists, diff: buildDiff(before, after) });
    };
    const pick = (role: typeof ROLES[number]) => getCandidates(policy, role).find(candidate => candidate.executor === provider);
    const root = pick("orchestrate");
    if (provider === "claude") {
      const advisor = pick("advisor");
      const patch = { ...(root ? { model: root.model } : {}), ...(advisor ? { advisorModel: advisor.model } : {}) };
      if (Object.keys(patch).length) await add(join(this.home, ".claude/settings.json"), text => updateJsonFields(text, patch));
    } else if (provider === "codex") {
      const child = pick("implement");
      const patch = { ...(root ? { model: root.model, model_reasoning_effort: root.effort ?? null } : {}), ...(child ? { "agents.default_subagent_model": child.model } : {}) };
      if (Object.keys(patch).length) await add(join(this.home, ".codex/config.toml"), text => updateTomlFields(text, patch));
    } else if (root) {
      const display = models.find(model => model.model === root.model)?.displayName;
      if (!display) throw new TypeError("Refresh Antigravity models before applying the root model");
      await add(join(this.home, ".gemini/antigravity-cli/settings.json"), text => updateJsonFields(text, { model: display }));
    }
    for (const role of ROLES.filter(role => role !== "orchestrate")) {
      const candidate = pick(role);
      if (!candidate) continue;
      if (provider === "codex") {
        await add(join(this.home, `.codex/agents/${role}.toml`), text => updateTomlFields(text, { model: candidate.model, model_reasoning_effort: candidate.effort ?? null }));
      } else {
        const model = provider === "claude" ? candidate.model : /gemini.*pro/i.test(candidate.model) ? "pro" : /gemini.*flash/i.test(candidate.model) ? "flash" : "inherit";
        await add(join(this.home, provider === "claude" ? `.claude/agents/${role}.md` : `.gemini/config/agents/${role}.md`), text => text ? updateAgentModel(text, model) : `---\nname: ${role}\ndescription: ${role}\nmodel: ${JSON.stringify(model)}\n---\n`);
      }
    }
    const mcp = provider === "antigravity" ? await this.readMcpRegistration() : this.mcp;
    const token = randomUUID();
    this.previews.set(token, { provider, changes, policy: JSON.stringify(policy) });
    return { token, provider, files: changes.map(({ path, diff }) => ({ path, diff })), ...(provider === "antigravity" ? { mcpCommand: ["agy", "mcp", "add", "agent-graph", "--", mcp.command, ...mcp.args].map(value => /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`).join(" ") } : {}) };
  }
  async apply(token: string, provider: Executor, policy: Policy, confirmation: boolean): Promise<void> {
    const preview = this.previews.get(token);
    if (!confirmation || !preview || preview.provider !== provider || preview.policy !== JSON.stringify(policy)) throw new TypeError("Matching provider preview and confirmation required");
    for (const change of preview.changes) {
      const current = await readTarget(change.path);
      if (current.text !== change.before || current.exists !== change.exists) throw new TypeError("Provider settings changed; preview again");
    }
    this.previews.delete(token);
    for (const change of preview.changes) await writeAtomic(change.path, change.after);
  }
}
