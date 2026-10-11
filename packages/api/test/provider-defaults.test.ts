import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { resolveProviderDefaults, type DefaultOptions } from "../src/settings/defaults.ts";

const execute = promisify(execFile);
async function createFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "provider-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), cwd = join(root, "project");
  await mkdir(home); await mkdir(cwd);
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
  const options: DefaultOptions = { home, env, managedClaudePath: join(root, "managed-settings.json") };
  async function seed(path: string, value: string | object) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value)); return path; }
  return { root, home, cwd, options, seed, resolve: (provider: "claude" | "codex", directory = cwd) => resolveProviderDefaults(provider, directory, [], options) };
}

test("Claude resolves environment > local > project > user, with field provenance", async t => {
  const f = await createFixture(t);
  const user = await f.seed(join(f.home, ".claude/settings.json"), { model: "claude-opus-5", effortLevel: "high" });
  assert.equal((await f.resolve("claude")).model, "claude-opus-5");
  assert.deepEqual((await f.resolve("claude")).modelSource, { kind: "file", path: user, key: "model" });
  const project = await f.seed(join(f.cwd, ".claude/settings.json"), { model: "claude-sonnet-5", effortLevel: "low" });
  assert.equal((await f.resolve("claude")).model, "claude-sonnet-5");
  assert.deepEqual((await f.resolve("claude")).effortSource, { kind: "file", path: project, key: "effortLevel" });
  const local = await f.seed(join(f.cwd, ".claude/settings.local.json"), { model: "claude-opus-5-5", effortLevel: "medium" });
  assert.equal((await f.resolve("claude")).modelSource.path, local);
  f.options.env!.ANTHROPIC_MODEL = "claude-sonnet-5-5";
  f.options.env!.CLAUDE_CODE_EFFORT_LEVEL = "high";
  const result = await f.resolve("claude");
  assert.equal(result.model, "claude-sonnet-5-5"); assert.equal(result.effort, "high");
  assert.deepEqual(result.modelSource, { kind: "environment", key: "ANTHROPIC_MODEL" });
  assert.deepEqual(result.effortSource, { kind: "environment", key: "CLAUDE_CODE_EFFORT_LEVEL" });
});
test("Claude resolves pinned aliases, settings env and per-model effort; ignores legacy user effort on 5.5", async t => {
  const f = await createFixture(t);
  const path = await f.seed(join(f.home, ".claude/settings.json"), { model: "opus", effortLevel: "high", env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5" } });
  let result = await f.resolve("claude");
  assert.equal(result.model, "claude-opus-5-5"); assert.equal(result.effort, "medium");
  assert.deepEqual(result.modelSource, { kind: "file", path, key: "env.ANTHROPIC_DEFAULT_OPUS_MODEL" });
  await f.seed(path, { model: "claude-opus-5-5", effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } });
  result = await f.resolve("claude"); assert.equal(result.effort, "low");
  assert.deepEqual(result.effortSource, { kind: "file", path, key: "modelSettings.claude-opus-5-5.effortLevel" });
  await f.seed(join(f.cwd, ".claude/settings.json"), { effortLevel: "xhigh" });
  assert.equal((await f.resolve("claude")).effort, "xhigh");
});
test("Claude reports account defaults and unresolved aliases as unknown instead of choosing a catalog row", async t => {
  const f = await createFixture(t);
  assert.equal((await f.resolve("claude")).model, null);
  await f.seed(join(f.home, ".claude/settings.json"), { model: "default" });
  assert.equal((await f.resolve("claude")).displayName, null);
  await f.seed(join(f.home, ".claude/settings.json"), { model: "opus" });
  assert.equal((await f.resolve("claude")).model, null);
  const result = await resolveProviderDefaults("claude", f.cwd, [{ model: "opus", displayName: "Opus 5.5" }], f.options);
  assert.equal(result.displayName, "Opus 5.5"); assert.equal(result.effort, "medium");
  await f.seed(join(f.home, ".claude/settings.json"), '{"model":"secret",');
  const unavailable = await f.resolve("claude"); assert.equal(unavailable.model, null); assert.ok(!JSON.stringify(unavailable).includes("secret"));
  await assert.rejects(f.resolve("claude", "relative"), /absolute/);
});
test("Claude reads the repository local file when launched in a subdirectory", async t => {
  const f = await createFixture(t);
  await execute("git", ["init", "-q", f.cwd], { env: f.options.env });
  const sub = join(f.cwd, "sub"); await mkdir(sub);
  const path = await f.seed(join(f.cwd, ".claude/settings.local.json"), { model: "claude-opus-5-5" });
  await f.seed(join(sub, ".claude/settings.local.json"), { model: "claude-sonnet-5-5" });
  assert.equal(await realpath((await f.resolve("claude", sub)).modelSource.path!), await realpath(path));
});
test("Claude managed settings and effort caps override local settings with the effective provenance", async t => {
  const f = await createFixture(t);
  await f.seed(join(f.cwd, ".claude/settings.local.json"), { model: "claude-sonnet-5-5", effortLevel: "high" });
  const path = await f.seed(f.options.managedClaudePath!, { model: "claude-opus-5-5", maxEffortLevel: "low" });
  const result = await f.resolve("claude"); assert.equal(result.model, "claude-opus-5-5"); assert.equal(result.effort, "low");
  assert.deepEqual(result.effortSource, { kind: "file", path, key: "maxEffortLevel" });
});

async function requireCodex(t: TestContext): Promise<boolean> {
  try { await execute("codex", ["--version"]); return true; }
  catch { t.skip("Codex CLI unavailable"); return false; }
}
test("Codex CLI resolves trusted nearest project > user and keeps model and effort origins separate", async t => {
  if (!await requireCodex(t)) return;
  const f = await createFixture(t);
  await execute("git", ["init", "-q", f.cwd], { env: f.options.env });
  const sub = join(f.cwd, "sub"); await mkdir(sub);
  const user = await f.seed(join(f.home, ".codex/config.toml"), `model = "user-model"\nmodel_reasoning_effort = "high"\n[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "trusted"\n`);
  let result = await f.resolve("codex", sub);
  assert.equal(result.model, "user-model"); assert.equal(result.effort, "high"); assert.equal(await realpath(result.modelSource.path!), await realpath(user));
  const project = await f.seed(join(f.cwd, ".codex/config.toml"), 'model = "project-model"\n');
  result = await f.resolve("codex", sub); assert.equal(result.model, "project-model"); assert.equal(await realpath(result.modelSource.path!), await realpath(project)); assert.equal(await realpath(result.effortSource.path!), await realpath(user));
  const nearest = await f.seed(join(sub, ".codex/config.toml"), 'model = "nearest-model"\nmodel_reasoning_effort = "low"\n');
  result = await f.resolve("codex", sub); assert.equal(result.model, "nearest-model"); assert.equal(result.effort, "low");
  assert.equal(await realpath(result.modelSource.path!), await realpath(nearest)); assert.equal(result.modelSource.key, "model");
});
test("Codex ignores untrusted project settings and does not activate legacy profiles on current CLI", async t => {
  if (!await requireCodex(t)) return;
  const f = await createFixture(t);
  await execute("git", ["init", "-q", f.cwd], { env: f.options.env });
  const path = await f.seed(join(f.home, ".codex/config.toml"), `model = "user-model"\n[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "untrusted"\n`);
  await f.seed(join(f.home, ".codex/review.config.toml"), 'model = "profile-model"\n');
  await f.seed(join(f.cwd, ".codex/config.toml"), 'model = "project-model"\n');
  assert.equal((await f.resolve("codex")).model, "user-model");
  await f.seed(path, 'model = "user-model"\nprofile = "review"\n[profiles.review]\nmodel = "legacy-profile-model"\n');
  assert.equal((await f.resolve("codex")).model, null);
});
test("Codex built-in model and effort come from native model/list, not a hardcoded version", async t => {
  if (!await requireCodex(t)) return;
  const f = await createFixture(t); await mkdir(join(f.home, ".codex"));
  const result = await f.resolve("codex");
  assert.ok(result.model); assert.ok(result.effort);
  assert.deepEqual(result.modelSource, { kind: "provider", key: "model/list.isDefault" });
  assert.deepEqual(result.effortSource, { kind: "provider", key: "model/list.defaultReasoningEffort" });
});
test("Codex defaults stay unknown when the CLI is unavailable and discard raw errors", async t => {
  const f = await createFixture(t); f.options.codex = async () => { throw new Error("secret"); };
  const result = await f.resolve("codex"); assert.equal(result.model, null); assert.equal(result.effort, null); assert.ok(!JSON.stringify(result).includes("secret"));
});
