import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseRows, switchCodexModel, type PaneControl } from "../src/codex-model.ts";
import { codexModels, modelCatalog, resolveClaudeModel } from "../src/models.ts";
import { parseAction } from "../src/actions.ts";

// 実際の Codex の選択画面を写した偽の pane。キーに応じて画面を進める
function fakeCodex(models: string[], levels: string[], advanced: string[]) {
  const sent: string[] = [];
  let screen = "› Ask Codex to do anything\n  GPT-6.1-Sol medium · ~/repo";
  let cursor = 0;
  let model = "";
  let mode: "idle" | "models" | "levels" | "advanced" = "idle";
  const render = () => {
    if (mode === "models") screen = ["  Select Model and Effort", ...models.map((label, index) => `${index === 0 ? "›" : " "} ${index + 1}. ${label}${index === 0 ? " (current)" : ""}  説明`), "  enter select · esc back"].join("\n");
    if (mode === "levels") screen = [`  Select Reasoning Level for ${model}`, ...levels.map((label, index) => `${index === cursor ? "›" : " "} ${index + 1}. ${label}  説明`), "  enter default · s session · esc back"].join("\n");
    if (mode === "advanced") screen = ["  Advanced Reasoning", ...advanced.map((label, index) => `${index === cursor ? "›" : " "} ${index + 1}. ${label}  説明`), "  enter default · s session · esc back"].join("\n");
  };
  const control: PaneControl = {
    read: async () => screen,
    prompt: async (_pane, text) => { sent.push(`prompt:${text}`); if (text === "/model") { mode = "models"; render(); } },
    keys: async (_pane, ...keys) => {
      for (const key of keys) {
        sent.push(key);
        const rows = mode === "advanced" ? advanced : levels;
        if (mode === "models" && /^\d$/.test(key)) { model = models[Number(key) - 1]; mode = "levels"; cursor = 1; }
        else if (key === "down") cursor = (cursor + 1) % rows.length;
        else if (key === "enter" && mode === "levels" && levels[cursor].startsWith("More reasoning")) { mode = "advanced"; cursor = 0; }
        else if (key === "s") { mode = "idle"; screen = `• Model changed to x for this session only\n  ${model} y · ~/repo`; continue; }
        else if (key === "escape") { mode = "idle"; screen = "idle"; continue; }
        render();
      }
    },
  };
  return { control, sent };
}

const MODELS = ["GPT-6.1-Sol", "GPT-6-Astra", "GPT-6-Sol", "GPT-6-Luna"];
const LEVELS = ["Low", "Medium (default)", "High", "Extra high", "More reasoning…"];
const noWait = async () => {};

test("選択画面の行から番号と表示名と「›」を読む", () => {
  const rows = parseRows("  Select Reasoning Level for GPT-6-Luna\n  1. Low               Fast\n› 2. Medium (default)  Balances\n  5. More reasoning…   Max");
  assert.deepEqual(rows, [
    { number: 1, label: "Low", selected: false },
    { number: 2, label: "Medium", selected: true },
    { number: 5, label: "More reasoning", selected: false },
  ]);
});

test("Codex は番号でモデルを選び、矢印で effort の行に移り、s でその会話だけに効かせる", async () => {
  const { control, sent } = fakeCodex(MODELS, LEVELS, ["Max", "Ultra"]);
  const result = await switchCodexModel(control, "p", { slug: "gpt-6-luna", label: "GPT-6-Luna", effort: "xhigh" }, noWait);
  assert.equal(result.ok, true, result.message);
  // Medium から Extra high へ下に 2 つ。Enter は既定にして config.toml に書くので押さない
  assert.deepEqual(sent, ["prompt:/model", "4", "down", "down", "s"]);
});

test("Codex の max と ultra は More reasoning の中で選ぶ", async () => {
  const { control, sent } = fakeCodex(MODELS, LEVELS, ["Max", "Ultra"]);
  const result = await switchCodexModel(control, "p", { slug: "gpt-6-astra", label: "GPT-6-Astra", effort: "ultra" }, noWait);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(sent, ["prompt:/model", "2", "down", "down", "down", "enter", "down", "s"]);
});

test("Codex で選べない effort や知らないモデルは、選択画面を閉じて理由を返す", async () => {
  const luna = fakeCodex(MODELS, LEVELS, ["Max"]);
  const noUltra = await switchCodexModel(luna.control, "p", { slug: "gpt-6-luna", label: "GPT-6-Luna", effort: "ultra" }, noWait);
  assert.equal(noUltra.ok, false);
  assert.match(noUltra.message, /does not support ultra/);
  assert.deepEqual(luna.sent.slice(-2), ["escape", "escape"]);
  const unknown = fakeCodex(MODELS, LEVELS, ["Max"]);
  const missing = await switchCodexModel(unknown.control, "p", { slug: "gpt-9", label: "GPT-9" }, noWait);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /GPT-9 was not found/);
});

test("モデルの一覧は Claude の版つきの名前と、models_cache.json の Codex の選択肢と effort を持つ", () => {
  const home = mkdtempSync(join(tmpdir(), "ag-models-"));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }, { effort: "ultra" }], default_reasoning_level: "medium" },
    { slug: "hidden", display_name: "Hidden", visibility: "hide", supported_reasoning_levels: [] },
  ] }));
  assert.deepEqual(codexModels(home), [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "max", "ultra"], defaultEffort: "medium" }]);
  assert.deepEqual(codexModels(join(home, "missing")), []);
  const claude = modelCatalog(home).claude;
  assert.ok(claude.some((model) => model.id === "claude-opus-5-5" && model.label === "Opus 5.5"));
  assert.ok(claude.some((model) => model.id === "claude-opus-5" && model.label === "Opus 5"));
  assert.deepEqual(claude.find((model) => model.id === "claude-fable-5-1")?.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("set_model は effort を段階の名前だけ受け付ける", () => {
  assert.equal(parseAction({ action: "set_model", repo: "r", sessionId: "s", model: "gpt-6-astra", effort: "xhigh" }).effort, "xhigh");
  assert.equal(parseAction({ action: "set_model", repo: "r", sessionId: "s", model: "claude-opus-5-5" }).effort, undefined);
  assert.throws(() => parseAction({ action: "set_model", repo: "r", sessionId: "s", model: "m", effort: "turbo" }), /Invalid effort/);
});

test("Agent ツールの別名は、同じ系統なら親のモデルに、違えば一覧の最新の版に直す", () => {
  assert.equal(resolveClaudeModel("opus", "claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(resolveClaudeModel("opus", "claude-opus-5"), "claude-opus-5");
  assert.equal(resolveClaudeModel("sonnet", "claude-opus-5-5"), "claude-sonnet-5-5");
  assert.equal(resolveClaudeModel("haiku", ""), "claude-haiku-4-5-20251001");
  assert.equal(resolveClaudeModel("opus[1m]", "claude-sonnet-5"), "claude-opus-5-5[1m]");
  assert.equal(resolveClaudeModel("", "claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(resolveClaudeModel("inherit", "claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(resolveClaudeModel("claude-sonnet-5", "claude-opus-5-5"), "claude-sonnet-5");
  assert.equal(resolveClaudeModel("gpt-6-astra", "claude-opus-5-5"), "gpt-6-astra");
});

test("親の会話のモデルが別名でも版つきに直す", () => {
  assert.equal(resolveClaudeModel("", "fable"), "claude-fable-5-1");
  assert.equal(resolveClaudeModel("opus", "opus[1m]"), "claude-opus-5-5");
});
