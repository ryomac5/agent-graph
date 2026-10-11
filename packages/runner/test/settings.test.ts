import { test } from "node:test";
import assert from "node:assert/strict";
import { RunnerSettings } from "../src/settings.ts";
import { defaultConfig } from "../../core/src/settings/index.ts";
import { defaultPolicy, getCandidates } from "../../core/src/assign/policy.ts";

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
  const policy = defaultPolicy(); getCandidates(policy, "implement").reverse(); runner.applyPolicy(policy);
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

test("real runtime accepts api preflight/apply and next UI and planner delegations use applied settings", async t => {
  const { fixture, messages, until } = await import("./samples/S13/fixture.ts");
  const f = fixture(t, { liveSettings: true });
  const api = f.connect(); const replies = messages(api.client);
  api.client.write(JSON.stringify({ type: "hello", version: 1, role: "api" }) + "\n");
  let counter = 0;
  async function command(command: string, payload: unknown) {
    const cmd_id = `live-settings-${++counter}`;
    api.client.write(JSON.stringify({ type: "req", command, cmd_id, payload }) + "\n");
    await until(() => replies.some(reply => reply.cmd_id === cmd_id));
    const response = replies.find(reply => reply.cmd_id === cmd_id);
    assert.equal(response.ok, true, response.error);
    return response.result;
  }
  const policy = defaultPolicy();
  getCandidates(policy, "implement")[0].model = "applied-model";
  const payload = { store: "policy", value: policy };
  assert.deepEqual(await command("runner.settings.preflight", payload), { valid: true });
  assert.notEqual(getCandidates(f.runtime.settings.forNextDelegation().policy, "implement")[0].model, "applied-model");
  assert.deepEqual(await command("runner.settings.apply", payload), { applied: true });
  await assert.rejects(f.runtime.command({ type: "req", cmd_id: "forbidden", command: "runner.settings.apply", payload: JSON.parse(JSON.stringify(payload)) }), /api connection/);
  const project = { acceptance: { commands: ["exit 9"] }, scope: { exclude: ["secret/**"] }, isolation: { policy: "read-only" } };
  await command("runner.settings.preflight", { store: "project", value: project, repositoryId: f.request.cwd });
  await command("runner.settings.apply", { store: "project", value: project, repositoryId: f.request.cwd });
  for (const source of ["ui", "planner"] as const) {
    const id = `applied-${source}`;
    const request = { ...f.request, requestId: id, source, accept: [], repositoryId: f.request.cwd };
    await command("intake.submit", request);
    await until(() => f.host.starts.length === (source === "ui" ? 1 : 2));
    const run = f.host.starts.at(-1)!;
    assert.equal(run.model.model, "applied-model");
    f.host.emit(run.runId, { type: "exit", exitCode: 0 });
    await f.intake.wait(id);
    const result = f.intake.status(id).result!;
    assert.equal(result.acceptance.results[0].command, "exit 9");
    assert.equal(result.acceptance.passed, false);
  }
});

test("MCP model tools use the applied runtime policy and validate role and weight", async t => {
  const { fixture, messages, until } = await import("./samples/S13/fixture.ts");
  const f = fixture(t, { liveSettings: true });
  const policy = defaultPolicy(); getCandidates(policy, "verify")[0].model = "next-sonnet";
  await f.runtime.command({ type: "req", cmd_id: "apply-mcp", command: "runner.settings.apply", payload: JSON.parse(JSON.stringify({ store: "policy", value: policy })) }, "api");
  const mcp = f.connect(); const replies = messages(mcp.client);
  mcp.client.write(JSON.stringify({ type: "hello", version: 1, role: "mcp" }) + "\n");
  let id = 0;
  async function call(name: string, args: unknown = {}) {
    const requestId = ++id;
    mcp.client.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } }) + "\n");
    await until(() => replies.some(reply => reply.id === requestId));
    return replies.find(reply => reply.id === requestId);
  }
  const resolved = (await call("resolve_model", { role: "verify", weight: "heavy" })).result.structuredContent;
  assert.equal(resolved.model, "next-sonnet"); assert.equal(resolved.executor, "claude"); assert.ok(resolved.reason.length);
  const table = (await call("assignment_table")).result.structuredContent;
  assert.deepEqual(Object.keys(table.roles).sort(), ["orchestrate", "advisor", "research", "implement", "document", "review", "verify", "proofread"].sort());
  assert.equal(table.roles.verify.standard[0].model, "next-sonnet");
  mcp.client.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "assignment_table" } }) + "\n");
  await until(() => replies.some(reply => reply.id === 99));
  assert.equal(replies.find(reply => reply.id === 99).result.structuredContent.roles.verify.standard[0].model, "next-sonnet");
  assert.match((await call("resolve_model", { role: "plan" })).error.message, /role/);
  assert.match((await call("resolve_model", { role: "verify", weight: "invalid" })).error.message, /weight/);
});
