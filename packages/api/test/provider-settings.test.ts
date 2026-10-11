import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProviderSettings, updateJsonFields, updateAgentModel } from "../src/settings/providers.ts";
import { updateTomlFields } from "../src/settings/toml.ts";
import { defaultPolicy, getCandidates } from "../../core/src/assign/policy.ts";

const MCP = { command: "/fixture/node", args: ["/fixture/shim.ts"] };
async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(join(tmpdir(), "provider-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const providers = new ProviderSettings(home, MCP);
  async function seed(path: string, text: string) { const file = join(home, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); return file; }
  return { home, providers, seed };
}

test("Claude preview is read-only, confirmation is required, and only model fields change atomically", async t => {
  const f = await fixture(t); const policy = defaultPolicy();
  const settings = '{\n  "permissions": {"allow": ["Read"]},\n  "model": "old",\n  "advisorModel": "old-advisor",\n  "env": {"X": "unchanged"}\n}\n';
  const settingsPath = await f.seed(".claude/settings.json", settings);
  const agent = '---\nname: verify\nmodel: old # keep\ndescription: "Test code"\n---\nInstructions stay.\n';
  const agentPath = await f.seed(".claude/agents/verify.md", agent);
  const inode = (await stat(settingsPath)).ino;
  const preview = await f.providers.preview("claude", policy);
  assert.ok(preview.files.some(file => file.path === settingsPath));
  assert.ok(preview.files.some(file => file.path === agentPath));
  assert.match(preview.files[0].diff, /-  "model": "old"/);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  await assert.rejects(f.providers.apply(preview.token, "claude", policy, false), /confirmation/);
  await f.providers.apply(preview.token, "claude", policy, true);
  assert.notEqual((await stat(settingsPath)).ino, inode);
  assert.equal(await readFile(settingsPath, "utf8"), settings.replace('"model": "old"', '"model": "opus"').replace('"advisorModel": "old-advisor"', '"advisorModel": "fable"'));
  assert.equal(await readFile(agentPath, "utf8"), agent.replace('model: old', 'model: "sonnet"'));
  await assert.rejects(f.providers.apply(preview.token, "claude", policy, true), /preview/);
});

test("Codex changes root effort, default subagent and role models while preserving other TOML", async t => {
  const f = await fixture(t); const policy = defaultPolicy();
  policy.roles.orchestrate = { standard: [{ executor: "codex", model: "gpt-root", effort: "high", family: "openai", tier: "high" }] };
  const config = 'model = "old" # root\nmodel_reasoning_effort = "low"\n# Leave this\n[agents]\nmax_threads = 4\ndefault_subagent_model = "old-child" # child\n[mcp_servers."agent-graph"]\ncommand = "node"\nargs = ["shim.ts"]\n[other]\nliteral = \'keep\'\n';
  const path = await f.seed(".codex/config.toml", config);
  const rolePath = await f.seed(".codex/agents/implement.toml", 'model = "old"\nmodel_reasoning_effort = "low" # effort\ndeveloper_instructions = """\nDo work.\n"""\n');
  const preview = await f.providers.preview("codex", policy);
  await f.providers.apply(preview.token, "codex", policy, true);
  assert.equal(await readFile(path, "utf8"), config.replace('model = "old"', 'model = "gpt-root"').replace('model_reasoning_effort = "low"', 'model_reasoning_effort = "high"').replace('default_subagent_model = "old-child"', 'default_subagent_model = "gpt-6-astra"'));
  assert.equal(await readFile(rolePath, "utf8"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high" # effort\ndeveloper_instructions = """\nDo work.\n"""\n');
});

test("Antigravity uses displayed root names, limited child aliases, and the MCP registration command", async t => {
  const f = await fixture(t); const policy = defaultPolicy();
  const candidate = (model: string) => ({ executor: "antigravity" as const, family: "google" as const, tier: "high" as const, model });
  policy.roles.orchestrate = [candidate("claude-opus-5-high")];
  policy.roles.research = [candidate("gemini-3.1-pro-high")]; policy.roles.document = [candidate("claude-sonnet-5-high")];
  const rootPath = await f.seed(".gemini/antigravity-cli/settings.json", '{ "model": "old", "theme": "system" }\n');
  const paths = await Promise.all(["research", "document", "proofread"].map(role => f.seed(`.gemini/config/agents/${role}.md`, `---\nname: ${role}\nmodel: inherit\n---\nKeep body.\n`)));
  await assert.rejects(f.providers.preview("antigravity", policy), /Refresh/);
  const preview = await f.providers.preview("antigravity", policy, [{ model: "claude-opus-5-high", displayName: "Claude Opus 5 High" }]);
  assert.equal(preview.mcpCommand, "agy mcp add agent-graph -- /fixture/node /fixture/shim.ts");
  await f.providers.apply(preview.token, "antigravity", policy, true);
  assert.equal(await readFile(rootPath, "utf8"), '{ "model": "Claude Opus 5 High", "theme": "system" }\n');
  assert.match(await readFile(paths[0], "utf8"), /model: "pro"/);
  assert.match(await readFile(paths[1], "utf8"), /model: "inherit"/);
  assert.match(await readFile(paths[2], "utf8"), /model: "flash"/);
});

test("provider apply rejects concurrent file edits and changed policies before writing any file", async t => {
  const f = await fixture(t); const policy = defaultPolicy();
  const path = await f.seed(".claude/settings.json", '{}\n');
  const agent = await f.seed(".claude/agents/verify.md", '---\nmodel: old\n---\n');
  let preview = await f.providers.preview("claude", policy);
  await writeFile(agent, '---\nmodel: manual\n---\n');
  await assert.rejects(f.providers.apply(preview.token, "claude", policy, true), /changed/);
  assert.equal(await readFile(path, "utf8"), '{}\n');
  preview = await f.providers.preview("claude", policy);
  getCandidates(policy, "advisor")[0].model = "changed";
  await assert.rejects(f.providers.apply(preview.token, "claude", policy, true), /preview/);
  assert.equal(await readFile(path, "utf8"), '{}\n');
});

test("targeted JSON, frontmatter and TOML updates retain nested values, comments and CRLF", () => {
  assert.equal(updateJsonFields('{"model":"old","nested":{"model":"keep","x":"}\\\""}}', { model: "new" }), '{"model":"new","nested":{"model":"keep","x":"}\\\""}}');
  assert.deepEqual(JSON.parse(updateJsonFields('{}', { model: "new" })), { model: "new" });
  assert.equal(updateTomlFields('model = "old"\r\n# comment\r\n[agents]\r\nmax_threads = 2\r\n', { model: "new", "agents.default_subagent_model": "child" }), 'model = "new"\r\n# comment\r\n[agents]\r\nmax_threads = 2\r\n\r\ndefault_subagent_model = "child"');
  assert.throws(() => updateAgentModel('---\nmodel: old\nmodel: duplicate\n---\n', "new"), /one model/);
});

test("Antigravity registration copies the current Codex command and arguments from the temporary home", async t => {
  const f = await fixture(t);
  await f.seed('.codex/config.toml', '[unrelated]\ntext = """\nKeep this.\n"""\n[mcp_servers."agent-graph"]\ncommand = "/custom/node"\nargs = [\n  "/custom/shim.ts",\n  "--socket",\n  "/custom/runner.sock",\n]\n');
  const preview = await f.providers.preview("antigravity", defaultPolicy());
  assert.equal(preview.mcpCommand, "agy mcp add agent-graph -- /custom/node /custom/shim.ts --socket /custom/runner.sock");
});
