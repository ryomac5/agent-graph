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
