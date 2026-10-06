import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelChoice } from "./http/contract.ts";

// effort の段階。Claude Code の /effort と Codex の選択画面の両方の名前に合わせる
export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Claude の現行のモデル。Claude Code は変更できるモデルの一覧をファイルに持たないので、版つきで並べる。
// 値は Claude Code の /model がそのまま受け付ける正式な名前
const CLAUDE_MODELS: ModelChoice[] = [
  { id: "claude-fable-5-1", label: "Fable 5.1", efforts: CLAUDE_EFFORTS },
  { id: "claude-opus-5-5", label: "Opus 5.5", efforts: CLAUDE_EFFORTS },
  { id: "claude-opus-5-5[1m]", label: "Opus 5.5 1M", efforts: CLAUDE_EFFORTS },
  { id: "claude-opus-5", label: "Opus 5", efforts: CLAUDE_EFFORTS },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS },
  { id: "claude-sonnet-5", label: "Sonnet 5", efforts: CLAUDE_EFFORTS },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
];

interface CodexCacheModel {
  slug?: unknown; display_name?: unknown; visibility?: unknown;
  supported_reasoning_levels?: unknown; default_reasoning_level?: unknown;
}

// Codex の変更できるモデル。~/.codex/models_cache.json の選択肢を、Codex の選択画面と同じ順に並べる
export function codexModels(home = process.env.CODEX_HOME || join(homedir(), ".codex")): ModelChoice[] {
  let parsed: { models?: unknown };
  try { parsed = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as { models?: unknown }; }
  catch { return []; }
  if (!Array.isArray(parsed.models)) return [];
  const choices: ModelChoice[] = [];
  for (const raw of parsed.models as CodexCacheModel[]) {
    if (!raw || raw.visibility !== "list" || typeof raw.slug !== "string") continue;
    const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
    const efforts = levels.map((level) => typeof level === "string" ? level
      : level && typeof level === "object" && typeof (level as { effort?: unknown }).effort === "string" ? (level as { effort: string }).effort : "")
      .filter((level) => (EFFORTS as readonly string[]).includes(level));
    choices.push({ id: raw.slug, label: typeof raw.display_name === "string" ? raw.display_name : raw.slug, efforts,
      ...(typeof raw.default_reasoning_level === "string" ? { defaultEffort: raw.default_reasoning_level } : {}) });
  }
  return choices;
}

export function modelCatalog(codexHome?: string): ModelCatalog {
  return { claude: CLAUDE_MODELS, codex: codexModels(codexHome) };
}

// Claude Code の /model は別名も受け付ける。別名は常にその系列の最新版を指す
const CLAUDE_ALIASES: Record<string, string> = { fable: "Fable", opus: "Opus", "opus[1m]": "Opus 1M", sonnet: "Sonnet", haiku: "Haiku" };

// セッションの種類ごとに、切り替え先として受け付けるモデルを引く。Claude は別名も受け付ける
export function findModelChoice(client: "claude" | "codex", id: string, catalog: ModelCatalog = modelCatalog()): ModelChoice | undefined {
  const found = (client === "claude" ? catalog.claude : catalog.codex).find((item) => item.id === id);
  if (found || client !== "claude" || !CLAUDE_ALIASES[id]) return found;
  return { id, label: CLAUDE_ALIASES[id], efforts: id === "haiku" ? [] : CLAUDE_EFFORTS };
}
