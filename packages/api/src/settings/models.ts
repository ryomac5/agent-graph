import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
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
    return typeof model === "string" && model ? [{ model, displayName: String(e.displayName ?? e.display_name ?? e.name ?? model), ...(typeof e.effort === "string" ? { effort: e.effort } : {}) }] : [];
  });
}
async function readClaudeCatalog(home?: string): Promise<AvailableModel[]> {
  const directory = home ? join(home, ".claude") : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const configPath = !home && process.env.CLAUDE_CONFIG_DIR ? join(directory, ".claude.json") : join(home ?? homedir(), ".claude.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const organization = config.oauthAccount?.organizationUuid;
    if (typeof organization !== "string" || !organization) return [];
    const cacheDirectory = join(directory, "cache", "model-catalog");
    let latest: { fetchedAt: number; models: AvailableModel[] } = { fetchedAt: 0, models: [] };
    for (const file of await readdir(cacheDirectory)) {
      if (!file.startsWith(`${organization}-`) || !file.endsWith("-cc.json")) continue;
      try {
        const value = JSON.parse(await readFile(join(cacheDirectory, file), "utf8"));
        const models = value.catalog?.surface === "cc" ? parseModelList(value.catalog.config) : [];
        if (models.length && typeof value.fetchedAt === "number" && value.fetchedAt > latest.fetchedAt) latest = { fetchedAt: value.fetchedAt, models };
      } catch { /* 更新途中や旧形式のファイルは一覧の取得を妨げない。 */ }
    }
    return latest.models;
  } catch { return []; /* Claude Code のカタログがない環境ではホストの一覧を使う。 */ }
}
export function parseAgyModels(text: string): AvailableModel[] {
  try { return parseModelList(JSON.parse(text)); } catch {
    return [...new Map(text.split(/\r?\n/).flatMap(line => {
      const match = /^\s*(?:[-*]\s*)?((?:gemini|claude|gpt)[\w.-]+)(?:\s+(.*))?$/i.exec(line);
      if (!match) return [];
      const model = match[1];
      const displayName = match[2]?.replace(/^\s*[|:]\s*/, "").trim() || model;
      return [[model, { model, displayName }] as const];
    })).values()];
  }
}
export async function readAvailableModels(provider: "claude" | "codex" | "antigravity", list: (provider: "claude" | "codex") => Promise<unknown>, options: { home?: string; agy?: () => Promise<string> } = {}): Promise<AvailableModels> {
  let models: AvailableModel[] = [];
  if (provider === "antigravity") {
    try { models = parseAgyModels(await (options.agy ? options.agy() : run(process.env.AGENT_GRAPH_AGY_BIN || "agy", ["models"], { timeout: MODEL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }).then(result => result.stdout))); } catch { /* 一覧が取れないときは手入力を使う。 */ }
  } else {
    try { models = parseModelList(await list(provider)); } catch { /* ホストが不在ならキャッシュを試す。 */ }
    if (provider === "claude") {
      // runner の初期化結果より新しい、Claude Code のカタログを毎回読む。
      const cached = await readClaudeCatalog(options.home);
      models = [...new Map([...models, ...cached].map(model => [model.model, model])).values()];
    }
    if (provider === "codex") {
      try {
        const directory = options.home ? join(options.home, ".codex") : process.env.CODEX_HOME || join(homedir(), ".codex");
        const cached = parseModelList(JSON.parse(await readFile(join(directory, "models_cache.json"), "utf8")));
        models = [...new Map([...cached, ...models].map(model => [model.model, model])).values()];
      } catch { /* キャッシュは任意であり、モデル名の手入力を妨げない。 */ }
    }
  }
  return models.length ? { state: "known", models } : { state: "unknown", models: [] };
}
