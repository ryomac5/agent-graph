import { test } from "node:test";
import assert from "node:assert/strict";
import { RunnerSettings } from "../src/settings.ts";
import { defaultConfig } from "../../core/src/settings/index.ts";
import { defaultPolicy } from "../../core/src/assign/policy.ts";

test("runner applies settings at future boundaries and records relaxed approval", () => {
  const records: string[] = [];
  const runner = new RunnerSettings({ activeClaudeRuns: () => ["claude-run"], activeRuns: () => ["claude-run", "codex-run"], recordApprovalRelaxed: (id) => { records.push(id); } });
  const existingConversation = runner.forNewConversation("claude");
  const existingDelegation = runner.forNextDelegation();
  const config = defaultConfig(); config.agents.claude.model = "sonnet"; config.approval.mode = "never";
  runner.applyConfig(config);
  assert.equal(existingConversation.model, "opus"); assert.equal(runner.forNewConversation("claude").model, "sonnet");
  assert.equal(runner.forNextTurn().mode, "never"); assert.deepEqual(records, ["claude-run", "codex-run"]);
  config.agents.claude.authentication = "api_key";
  assert.throws(() => runner.applyConfig(config), /confirmation/);
  assert.equal(runner.forNewConversation("claude").authentication, "subscription");
  runner.applyConfig(config, true); assert.equal(runner.forNewConversation("claude").authentication, "api_key");
  const policy = defaultPolicy(); policy.roles.implement.reverse(); runner.applyPolicy(policy);
  assert.notDeepEqual(runner.forNextDelegation().policy.roles.implement, existingDelegation.policy.roles.implement);
  runner.applyProject("repo", { isolation: { policy: "read-only" }, acceptance: { commands: ["test"] }, scope: { exclude: ["secret"] } });
  assert.equal(runner.forNextExecution("repo").policy, "read-only");
  assert.deepEqual(runner.forNextDelegation("repo").project.acceptance.commands, ["test"]);
});

test("runner socket settings preflight is read-only and only accepts api connections", () => {
  const runner = new RunnerSettings({ activeClaudeRuns: () => ["active"], activeRuns: () => [], recordApprovalRelaxed() {} });
  const value = defaultConfig(); value.agents.claude.authentication = "api_key";
  const request = { type: "req" as const, cmd_id: "settings", command: "runner.settings.preflight", payload: JSON.parse(JSON.stringify({ store: "config", value })) };
  assert.throws(() => runner.handleRequest(request, "api"), /confirmation/);
  request.payload.confirmation = true;
  assert.deepEqual(runner.handleRequest(request, "api"), { valid: true });
  assert.equal(runner.forNewConversation("claude").authentication, "subscription");
  assert.throws(() => runner.handleRequest(request, "mcp"), /api/);
  request.command = "runner.settings.apply";
  assert.deepEqual(runner.handleRequest(request, "api"), { applied: true });
  assert.equal(runner.forNewConversation("claude").authentication, "api_key");
});

test("storage and retention apply at their own boundaries and snapshots remain unchanged", () => {
  const runner = new RunnerSettings({ activeClaudeRuns: () => [], activeRuns: () => [], recordApprovalRelaxed() {} });
  const existingFact = runner.forNewFact();
  const existingCleanup = runner.forNextCleanup();
  const config = defaultConfig();
  config.storage.scope = "metadata";
  config.storage.redaction.patterns = ["private"];
  config.storage.bodyRetentionDays = 30;
  runner.applyConfig(config);
  assert.equal(existingFact.scope, "tool_output");
  assert.equal(existingCleanup.bodyRetentionDays, 90);
  assert.deepEqual(runner.forNewFact(), { scope: "metadata", redaction: { defaults: true, patterns: ["private"] } });
  assert.deepEqual(runner.forNextCleanup(), { bodyRetentionDays: 30, metadataRetentionDays: null });
  runner.forNewFact().redaction.patterns.push("mutated");
  assert.deepEqual(runner.forNewFact().redaction.patterns, ["private"]);
  runner.applyProject("repo", { isolation: { policy: null } });
  assert.equal(runner.forNextExecution("repo").policy, "workspace-write");
});
