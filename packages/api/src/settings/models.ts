import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AvailableModel, AvailableModels } from "../../../core/src/settings/index.ts";
const run = promisify(execFile);
const MODEL_TIMEOUT_MS = 5000;
export function parseModelList(value: unknown): AvailableModel[] {
  const entries = Array.isArray(value) ? value : value && typeof value === "object" ? (value as Record<string, unknown>).models : [];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const model = e.model ?? e.slug ?? e.id;
    return typeof model === "string" && model ? [{ model, displayName: String(e.displayName ?? e.display_name ?? model), ...(typeof e.effort === "string" ? { effort: e.effort } : {}) }] : [];
  });
}
export function parseAgyModels(text: string): AvailableModel[] {
  try { return parseModelList(JSON.parse(text)); } catch {
    return [...new Set(text.split(/\r?\n/).flatMap(line => {
      const model = /^\s*(?:[-*]\s*)?((?:gemini|claude|gpt)[\w.-]+)(?:\s|$)/i.exec(line)?.[1];
      return model ? [model] : [];
    }))].map(model => ({ model, displayName: model }));
  }
}
export async function readAvailableModels(provider: "claude" | "codex" | "antigravity", list: (provider: "claude" | "codex") => Promise<unknown>, options: { home?: string; agy?: () => Promise<string> } = {}): Promise<AvailableModels> {
  let models: AvailableModel[] = [];
  if (provider === "antigravity") {
    try { models = parseAgyModels(await (options.agy ? options.agy() : run(process.env.AGENT_GRAPH_AGY_BIN || "agy", ["models"], { timeout: MODEL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then(result => result.stdout))); } catch { /* 一覧が取れないときは手入力を使う。 */ }
  } else {
    try { models = parseModelList(await list(provider)); } catch { /* ホストが不在ならキャッシュを試す。 */ }
    if (provider === "codex") {
      try {
        const cached = parseModelList(JSON.parse(await readFile(join(options.home ?? homedir(), ".codex/models_cache.json"), "utf8")));
        models = [...new Map([...cached, ...models].map(model => [model.model, model])).values()];
      } catch { /* キャッシュは任意であり、モデル名の手入力を妨げない。 */ }
    }
  }
  return models.length ? { state: "known", models } : { state: "unknown", models: [] };
}
