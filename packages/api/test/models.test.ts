import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgyModels, readAvailableModels } from "../src/settings/models.ts";

test("model catalogs use list_models, merge Codex cache and allow unavailable manual models", async t => {
  const home = mkdtempSync(join(tmpdir(), "models-cache-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".codex")); writeFileSync(join(home, ".codex/models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", display_name: "Cached Astra" }, { slug: "gpt-6.1-sol", display_name: "Sol" }] }));
  const models = await readAvailableModels("codex", async () => [{ model: "gpt-6-astra", displayName: "Live Astra", effort: "xhigh" }], { home });
  assert.equal(models.state, "known"); assert.equal(models.models.length, 2); assert.equal(models.models[0].displayName, "Live Astra");
  const fallback = await readAvailableModels("codex", async () => { throw new Error("offline"); }, { home }); assert.equal(fallback.models.length, 2);
  assert.deepEqual(await readAvailableModels("claude", async () => { throw new Error("offline"); }), { state: "unknown", models: [] });
  assert.deepEqual(await readAvailableModels("antigravity", async () => [], { agy: async () => { throw new Error("offline"); } }), { state: "unknown", models: [] });
  const agy = await readAvailableModels("antigravity", async () => [], { agy: async () => 'gemini-3.8-flash-high Japanese\n' }); assert.equal(agy.models[0].model, "gemini-3.8-flash-high");
  assert.deepEqual(parseAgyModels('{"models":[{"id":"gemini-3.8-flash-high"}]}').map(m => m.model), ["gemini-3.8-flash-high"]);
});
test("CLI resolves weights as JSON and prints the session notice without starting services", t => {
  const root = mkdtempSync(join(tmpdir(), "models-cli-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, "models", ...args], { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: root } });
  assert.deepEqual(JSON.parse(run("resolve", "implement", "--weight", "heavy", "--json")).effort, "xhigh");
  assert.equal(run("resolve", "implement", "--weight", "light").trim(), "codex gpt-6.1-sol low");
  assert.match(run("notice"), /校正=antigravity gemini-3.8-flash-high。助言=claude fable/);
  assert.throws(() => run("resolve", "implement", "--weight", "huge"));
});

test("Claude Code catalogs replace stale host names and reload additions without restarting", async t => {
  const home = mkdtempSync(join(tmpdir(), "claude-catalog-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".claude/cache/model-catalog");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org" } }));
  const path = join(directory, "org-source-cc.json");
  const entries = [{ id: "claude-opus-5-5", name: "Opus 5.5" }, { id: "claude-fable-5-1", name: "Fable 5.1" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" }, { id: "claude-haiku-5-5", name: "Haiku 5.5" }];
  const write = (file: string, fetchedAt: number, models: typeof entries, surface = "cc") => writeFileSync(join(directory, file), JSON.stringify({ fetchedAt, catalog: { surface, config: { models } } }));
  write("org-source-cc.json", 10, entries);
  write("other-source-cc.json", 100, [{ id: "other-account", name: "Other account" }]);
  write("org-old-cc.json", 1, [{ id: "old", name: "Old catalog" }]);
  write("org-web-cc.json", 100, [{ id: "web", name: "Web" }], "web");
  writeFileSync(join(directory, "org-broken-cc.json"), "{");
  const list = async () => [{ model: "claude-opus-5-5", displayName: "Stale Opus" }, { model: "opus", displayName: "Opus 5" }];
  const first = await readAvailableModels("claude", list, { home });
  assert.deepEqual(first.models.filter(model => model.model !== "opus"), entries.map(entry => ({ model: entry.id, displayName: entry.name })));
  entries.push({ id: "claude-future-6", name: "Future 6" });
  writeFileSync(path, JSON.stringify({ fetchedAt: 11, catalog: { surface: "cc", config: { models: entries } } }));
  assert.ok((await readAvailableModels("claude", list, { home })).models.some(model => model.model === "claude-future-6"));
  write("org-new-cc.json", 12, [{ id: "claude-next-7", name: "Next 7" }]);
  assert.deepEqual((await readAvailableModels("claude", async () => { throw new Error("offline"); }, { home })).models, [{ model: "claude-next-7", displayName: "Next 7" }]);
});

test("Codex cache updates are read on every catalog request with an unchanged host", async t => {
  const home = mkdtempSync(join(tmpdir(), "codex-catalog-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/models_cache.json");
  const entries = [{ slug: "gpt-6-astra", display_name: "GPT-6-Astra" }];
  writeFileSync(path, JSON.stringify({ models: entries }));
  const list = async () => [{ model: "gpt-6-astra", displayName: "GPT-6-Astra" }];
  assert.equal((await readAvailableModels("codex", list, { home })).models.length, 1);
  entries.push({ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol" });
  writeFileSync(path, JSON.stringify({ models: entries }));
  assert.deepEqual((await readAvailableModels("codex", list, { home })).models.map(model => model.model), ["gpt-6-astra", "gpt-6.1-sol"]);
});
