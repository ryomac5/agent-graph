/**
 * SettingsService.handle({type:"cmd", cmd_id, command, payload}) -> {type:"ack", cmd_id, ok, result|error}.
 * settings.read {} -> {config, policy, project, errors, apiKeyConfigured}; browser settings never cross this API.
 * settings.previewPolicy {patch} -> {token, rows:[{id,before,after}]} (decide with recorded historical context).
 * settings.write {store:"config"|"policy"|"project", patch, previewToken?, confirmation?} -> {saved:true}.
 * Policy saves require a matching previewToken; confirmation allows authentication switching with active runs.
 * Narrowing storage returns existingPayloadDeletion:"requires_confirmation" and never removes old payloads.
 * settings.apiKey {value} or {remove:true} -> {configured:boolean}; KeychainPort is injected, no key getter.
 * settings.status {} -> SettingsStatus; settings.models {provider} -> {state,models} (unknown on failure).
 * Reads, status, models and previews are recomputed on every request; writes/key changes/rebuild retries reuse their result.
 * settings.rebuild {} -> {started:true}; status carries progress and resync fires on completion.
 * startSettingsWebSocketServer(observation, settings, options) uses the existing authenticated WebSocket server.
 * bindSettingsRequests(port, service) routes its request/responses, returns detach().
 * SettingsOptions.apply/preflight transfer validated settings to runner through its existing socket boundary.
 * Runner application failures return a fixed error without exposing the runner's exception text.
 * createRunnerSettingsTransport(port, repositoryId) sends runner.settings.preflight / runner.settings.apply
 * with {store, value, repositoryId, confirmation}; RunnerSettings.handleRequest(req, "api") returns {valid:true}/{applied:true}.
 * RunnerSettings applyConfig/applyPolicy/applyProject supply future conversation/turn/execution/delegation values.
 * RunnerSettings.forNewFact() supplies scope/redaction; forNextCleanup() supplies retention periods.
 * A save racing an unobserved manual edit is rejected; reload and preview again before saving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import { SettingsService, settingsPaths, type SettingsOptions } from "../src/settings/index.ts";
import { parseSettingsToml, updateSettingsToml } from "../src/settings/toml.ts";
import { defaultPolicy } from "../../core/src/assign/policy.ts";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "graph-settings-"));
  const paths = settingsPaths(root, { XDG_CONFIG_HOME: root });
  const ledger = openLedger(join(root, "ledger.db"));
  let key: string | undefined;
  const applied: string[] = [];
  const options: SettingsOptions = {
    paths, ledger, keychain: { async setClaudeApiKey(value) { key = value; }, async deleteClaudeApiKey() { key = undefined; }, async hasClaudeApiKey() { return key !== undefined; } },
    history: () => [{ id: "past", request: { role: "implement", title: "task", task: "task", accept: [] }, context: { quota: () => undefined, performance: () => undefined } }],
    async apply(store) { applied.push(store); },
    async status() { return { hosts: { claude: { state: "ready", version: "sdk", authentication: "subscription", degraded: [] }, codex: { state: "unknown", version: null, authentication: null, degraded: [] } }, connection: { runner: true, protocolVersion: 1, apiVersion: "2", updatePending: false }, observation: { formats: ["legacy", "jsonl"], unsupportedCount: 2 }, rebuild: { state: "idle", completed: 0, total: 0 }, logs: { api: "api.log", runner: "runner.log" } }; },
    async listModels() { throw new Error("Unavailable"); }, async rebuild(progress) { progress(1, 1); }, resync() { applied.push("resync"); },
  };
  const service = new SettingsService(options); await service.start();
  return { root, paths, ledger, service, applied, options, async close() { service.close(); ledger.close(); await rm(root, { recursive: true, force: true }); } };
}
async function waitUntil(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("Watch timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
test("atomic writes to each file store preserve untouched comments and preview policy", async () => {
  const f = await createFixture();
  try {
    await writeFile(f.paths.config, '# hand note\n[dashboard]\nport = 7500 # port note\n[observation]\nclaude = true # untouched\n');
    await f.service.reload("config");
    await f.service.write("config", { dashboard: { port: 7501 } });
    const saved = await readFile(f.paths.config, "utf8"); assert.match(saved, /# hand note/); assert.match(saved, /claude = true # untouched/); assert.match(saved, /7501 # port note/);
    await f.service.write("project", { scope: { exclude: ["secret"] } });
    assert.deepEqual(parseSettingsToml(await readFile(f.paths.project, "utf8")), { scope: { exclude: ["secret"] } });
    const patch = { roles: { implement: [...defaultPolicy().roles.implement].reverse() } };
    const previous = f.service.read("policy");
    const preview = f.service.previewPolicy(patch);
    assert.deepEqual(f.service.read("policy"), previous);
    assert.notDeepEqual(preview.rows[0].before, preview.rows[0].after);
    await assert.rejects(f.service.write("policy", patch), /preview/);
    await f.service.write("policy", patch, { previewToken: preview.token });
    assert.equal(f.service.read("policy").roles.implement[0].model, "opus");
    assert.ok(!(await readdir(join(f.root, "agent-graph"))).some((file) => file.endsWith(".tmp")));
    const facts = f.ledger.readSince(0, 100).filter((fact) => fact.kind === "setting.changed");
    assert.ok(facts.length >= 3); assert.ok(facts.every((fact) => !JSON.stringify(fact.payload).includes("7501")));
  } finally { await f.close(); }
});
test("invalid API and manual edits retain previous values; rename watches stay active", async () => {
  const f = await createFixture();
  try {
    await f.service.write("config", { dashboard: { port: 7550 } });
    const previous = await readFile(f.paths.config, "utf8");
    await assert.rejects(f.service.write("config", { dashboard: { port: -1 } }));
    assert.equal(await readFile(f.paths.config, "utf8"), previous);
    let rejected = false;
    f.options.onError = () => { rejected = true; };
    await writeFile(f.paths.config, '[dashboard]\nport = -1\n');
    await waitUntil(() => rejected);
    assert.equal(f.service.read("config").dashboard.port, 7550);
    const error = await f.service.handle({ type: "cmd", cmd_id: "read", command: "settings.read" }); assert.match(JSON.stringify(error), /Invalid/);
    await writeFile(f.paths.config, '[dashboard]\nport = 7551\n'); await waitUntil(() => f.service.read("config").dashboard.port === 7551);
    await f.service.write("config", { dashboard: { port: 7552 } });
    await writeFile(f.paths.config, '[dashboard]\nport = 7553\n'); await waitUntil(() => f.service.read("config").dashboard.port === 7553);
    assert.ok(f.ledger.readSince(0, 100).some((fact) => fact.kind === "setting.changed" && fact.payload?.origin === "file"));
  } finally { await f.close(); }
});
test("manual policy and project edits are validated before runner application", async () => {
  const f = await createFixture();
  try {
    const rejected = new Set<string>();
    f.options.onError = (store) => { rejected.add(store); };
    await writeFile(f.paths.policy, '[quota]\nsoftLimitPercent = 60\nhardLimitPercent = 80\n');
    await writeFile(f.paths.project, '[isolation]\npolicy = "read-only"\n');
    await waitUntil(() => f.service.read("policy").quota.hardLimitPercent === 80 && f.service.read("project").isolation.policy === "read-only");
    const applied = f.applied.length;
    await writeFile(f.paths.policy, '[quota]\nsoftLimitPercent = 90\nhardLimitPercent = 80\n');
    await writeFile(f.paths.project, '[isolation]\npolicy = "invalid"\n');
    await waitUntil(() => rejected.has("policy") && rejected.has("project"));
    assert.equal(f.applied.length, applied);
    assert.equal(f.service.read("policy").quota.softLimitPercent, 60);
    assert.equal(f.service.read("project").isolation.policy, "read-only");
    const changes = f.ledger.readSince(0, 100).filter((fact) => fact.kind === "setting.changed");
    assert.deepEqual(changes.map((fact) => fact.payload?.store).sort(), ["policy", "project"]);
    assert.ok(changes.every((fact) => fact.payload?.origin === "file"));
  } finally { await f.close(); }
});
test("Keychain never echoes secrets, command retry is idempotent, status and rebuild report progress", async () => {
  const f = await createFixture();
  try {
    const secret = "arbitrary-api-secret-do-not-echo";
    const cmd = { type: "cmd" as const, cmd_id: "key", command: "settings.apiKey", payload: { value: secret } };
    assert.deepEqual(await f.service.handle(cmd), await f.service.handle(cmd));
    assert.equal(f.ledger.readSince(0, 100).length, 1);
    for (const command of ["settings.read", "settings.status"]) assert.ok(!JSON.stringify(await f.service.handle({ type: "cmd", cmd_id: command, command })).includes(secret));
    assert.ok(!JSON.stringify(f.ledger.readSince(0, 100)).includes(secret));
    const models = await f.service.handle({ type: "cmd", cmd_id: "models", command: "settings.models", payload: { provider: "codex" } }); assert.match(JSON.stringify(models), /unknown/);
    await f.service.handle({ type: "cmd", cmd_id: "rebuild", command: "settings.rebuild" }); await waitUntil(() => f.applied.includes("resync"));
    assert.match(JSON.stringify(await f.service.handle({ type: "cmd", cmd_id: "status-after", command: "settings.status" })), /done/);
  } finally { await f.close(); }
});
test("TOML arrays, inline tables, strings with #, and comment retention", () => {
  const text = '# note\n[scope]\nexclude = [\n "a#b", # comment\n "c"\n]\n[acceptance]\ncommands = ["test"] # keep\n';
  const edited = updateSettingsToml(text, { scope: { exclude: ["d"] } });
  assert.match(edited, /commands = \["test"\] # keep/);
  assert.deepEqual(parseSettingsToml(edited), { scope: { exclude: ["d"] }, acceptance: { commands: ["test"] } });
  assert.deepEqual(parseSettingsToml('constraints = [{ kind = "reviewerDifferentFamily" }]'), { constraints: [{ kind: "reviewerDifferentFamily" }] });
  for (const table of ["[__proto__]", "[constructor.prototype]", "[[__proto__.entries]]"]) {
    assert.throws(() => parseSettingsToml(`${table}\nsettingsPolluted = true`), /Invalid TOML key/);
  }
  assert.equal(Object.hasOwn(Object.prototype, "settingsPolluted"), false);
  assert.throws(() => parseSettingsToml('scope = { __proto__ = { exclude = ["private"] } }'), /Invalid TOML key/);
});

test("saving unchanged arrays preserves multiline comments and policy candidate annotations", async () => {
  const f = await createFixture();
  try {
    const array = 'repositories = [\n  "repo-a", # first repository\n  "repo-b", # second repository\n]\n';
    await writeFile(f.paths.config, `[observation]\n${array}[dashboard]\nport = 7500\n`);
    await f.service.reload("config");
    await f.service.write("config", { observation: { repositories: ["repo-a", "repo-b"] }, dashboard: { port: 7501 } });
    assert.ok((await readFile(f.paths.config, "utf8")).includes(array));
    assert.equal(f.service.read("config").dashboard.port, 7501);

    const candidate = '[[roles.implement]]\nexecutor = "codex"\nmodel = "gpt-6-astra" # preferred model\nfamily = "openai"\ntier = "high"\n';
    await writeFile(f.paths.policy, `[quota]\nhardLimitPercent = 90\n${candidate}`);
    await f.service.reload("policy");
    const patch = { roles: { implement: f.service.read("policy").roles.implement }, quota: { hardLimitPercent: 95 } };
    const preview = f.service.previewPolicy(patch);
    await f.service.write("policy", patch, { previewToken: preview.token });
    assert.ok((await readFile(f.paths.policy, "utf8")).includes(candidate));
    assert.equal(f.service.read("policy").quota.hardLimitPercent, 95);
  } finally { await f.close(); }
});

test("updates nested inline tables and root policy fields without losing sibling settings", async () => {
  const f = await createFixture();
  try {
    const original = 'agents = { claude = { model = "opus", effort = "high" }, codex = { model = "existing" } } # hand note\n[dashboard]\nport = 7500 # keep\n';
    await writeFile(f.paths.config, original);
    await f.service.reload("config");
    await f.service.write("config", { agents: { claude: { model: "sonnet", effort: "medium" } } });
    const edited = await readFile(f.paths.config, "utf8");
    assert.match(edited, /# hand note/);
    assert.match(edited, /port = 7500 # keep/);
    assert.equal(f.service.read("config").agents.codex.model, "existing");
    assert.equal(f.service.read("config").agents.claude.effort, "medium");
    const policy = updateSettingsToml('maxRoundTrips = 2 # rounds\n[quota]\nhardLimitPercent = 90 # keep\n', { maxRoundTrips: 3 }, true);
    assert.match(policy, /maxRoundTrips = 3 # rounds/);
    assert.equal(parseSettingsToml(policy, true).maxRoundTrips, 3);
  } finally { await f.close(); }
});

test("policy preview becomes stale when another edit changes the saved rules", async () => {
  const f = await createFixture();
  try {
    const patch = { quota: { hardLimitPercent: 95 } };
    const preview = f.service.previewPolicy(patch);
    await writeFile(f.paths.policy, '[performance]\nminSamples = 30\n');
    await f.service.reload("policy");
    await assert.rejects(f.service.write("policy", patch, { previewToken: preview.token }), /preview/);
    assert.equal(f.service.read("policy").quota.hardLimitPercent, 90);
    const current = f.service.previewPolicy(patch);
    await f.service.write("policy", patch, { previewToken: current.token });
    assert.equal(f.service.read("policy").performance.minSamples, 30);
    assert.equal(f.service.read("policy").quota.hardLimitPercent, 95);
  } finally { await f.close(); }
});

test("read, host status and models are fetched again when a request ID is reused", async () => {
  const f = await createFixture();
  try {
    const read = { type: "cmd" as const, cmd_id: "refresh-read", command: "settings.read" };
    const first = await f.service.handle(read);
    await f.service.write("config", { dashboard: { port: 7591 } });
    const second = await f.service.handle(read);
    assert.notDeepEqual(first, second);
    assert.match(JSON.stringify(second), /7591/);
    let statusCalls = 0;
    const status = f.options.status;
    f.options.status = async () => { statusCalls++; return status(); };
    const statusRequest = { type: "cmd" as const, cmd_id: "refresh-status", command: "settings.status" };
    await f.service.handle(statusRequest); await f.service.handle(statusRequest);
    assert.equal(statusCalls, 2);
    let modelCalls = 0;
    f.options.listModels = async () => [{ model: `model-${++modelCalls}`, displayName: "Available" }];
    const modelRequest = { type: "cmd" as const, cmd_id: "refresh-models", command: "settings.models", payload: { provider: "claude" } };
    assert.notDeepEqual(await f.service.handle(modelRequest), await f.service.handle(modelRequest));
    assert.equal(modelCalls, 2);
  } finally { await f.close(); }
});

test("each file store replaces its inode atomically and preserves untouched comments", async () => {
  const f = await createFixture();
  try {
    const cases = [
      { store: "config" as const, text: '# config note\n[dashboard]\nport = 7500\n[observation]\ncodex = true # keep\n', patch: { dashboard: { port: 7501 } } },
      { store: "policy" as const, text: '# policy note\n[quota]\nsoftLimitPercent = 70 # keep\nhardLimitPercent = 90\n', patch: { quota: { hardLimitPercent: 95 } } },
      { store: "project" as const, text: '# project note\n[scope]\nexclude = ["private"] # keep\n[acceptance]\ncommands = ["old"]\n', patch: { acceptance: { commands: ["new"] } } },
    ];
    for (const { store, text, patch } of cases) {
      await writeFile(f.paths[store], text);
      await f.service.reload(store);
      const before = await stat(f.paths[store]);
      const previewToken = store === "policy" ? f.service.previewPolicy(patch).token : undefined;
      await f.service.write(store, patch, { previewToken });
      const after = await stat(f.paths[store]);
      assert.notEqual(after.ino, before.ino);
      assert.match(await readFile(f.paths[store], "utf8"), /# keep/);
      assert.deepEqual(parseSettingsToml(await readFile(f.paths[store], "utf8"), store === "policy"), parseSettingsToml(updateSettingsToml(text, patch, store === "policy"), store === "policy"));
    }
  } finally { await f.close(); }
});

test("policy TOML retains the existing table layout and preserves other rules", async () => {
  const { parsePolicyToml } = await import("../../core/src/assign/policy.ts");
  const original = '# policy note\n[quota]\nsoftLimitPercent = 70 # leave\nhardLimitPercent = 90\n[review]\nmax_round_trips = 2 # reviews\n[[roles.implement]]\nexecutor = "codex"\nmodel = "gpt-6-astra" # model\nfamily = "openai"\ntier = "high"\n';
  const edited = updateSettingsToml(original, { maxRoundTrips: 3, quota: { hardLimitPercent: 95 }, performance: { minSamples: 30, weights: { tokens: 0.2, roundTrips: 0.3 } } }, true);
  assert.match(edited, /softLimitPercent = 70 # leave/); assert.match(edited, /model = "gpt-6-astra" # model/);
  // 旧パーサーは行末注釈を読めないため、構造の互換だけを確認する。
  const withoutComments = edited.split("\n").map((line) => line.replace(/\s*#.*$/, "")).join("\n");
  assert.deepEqual(parseSettingsToml(edited, true), parsePolicyToml(withoutComments));
  assert.equal(parsePolicyToml(withoutComments).maxRoundTrips, 3);
  assert.throws(() => parseSettingsToml('[quota]\na = 1\n[quota]\nb = 2'), /Duplicate/);
  assert.throws(() => parseSettingsToml('[review]\nmax_round_trips = 2\nunknown = true', true), /Invalid review/);
  assert.throws(() => parseSettingsToml('maxRoundTrips = 3\n[review]\nmax_round_trips = 2', true), /Invalid review/);
});

test("failed application rolls back the file and retains runtime settings", async () => {
  const f = await createFixture();
  try {
    await f.service.write("config", { dashboard: { port: 7570 } });
    const before = await readFile(f.paths.config, "utf8");
    f.options.apply = async (_store, value) => { if ("dashboard" in value && value.dashboard.port === 7571) throw new Error("Apply failed"); };
    await assert.rejects(f.service.write("config", { dashboard: { port: 7571 } }));
    assert.equal(await readFile(f.paths.config, "utf8"), before);
    assert.equal(f.service.read("config").dashboard.port, 7570);
  } finally { await f.close(); }
});

test("WebSocket request adapter handles settings with existing request/response envelopes", async () => {
  const { bindSettingsRequests } = await import("../src/settings/websocket.ts");
  const f = await createFixture();
  const forwarded: string[] = [];
  const port: import("../src/settings/websocket.ts").SettingsRequestPort = { async request(request) {
    forwarded.push(request.command); return { type: "res", cmd_id: request.cmd_id, ok: true, result: {} };
  } };
  const detach = bindSettingsRequests(port, f.service);
  try {
    const response = await port.request({ type: "req", cmd_id: "ws-read", command: "settings.read" });
    assert.equal(response.type, "res"); assert.equal(response.cmd_id, "ws-read"); assert.equal(response.ok, true);
    assert.match(JSON.stringify(response), /"apiKeyConfigured":false/); assert.deepEqual(forwarded, []);
    await port.request({ type: "req", cmd_id: "other", command: "intake.status" }); assert.deepEqual(forwarded, ["intake.status"]);
  } finally {
    detach();
    await f.close();
  }
});

test("runner transport keeps protocol envelopes and rejects unacknowledged changes", async () => {
  const { createRunnerSettingsTransport } = await import("../src/settings/runner.ts");
  const commands: string[] = [];
  const port: import("../src/settings/websocket.ts").SettingsRequestPort = { async request(request) {
    commands.push(request.command);
    assert.equal((request.payload as Record<string, unknown>).repositoryId, "repository");
    return { type: "res", cmd_id: request.cmd_id, ok: true, result: { [request.command === "runner.settings.preflight" ? "valid" : "applied"]: true } };
  } };
  const transport = createRunnerSettingsTransport(port, "repository");
  await transport.preflight!("policy", defaultPolicy(), false); await transport.apply("policy", defaultPolicy(), false);
  assert.deepEqual(commands, ["runner.settings.preflight", "runner.settings.apply"]);
  const unacknowledged: Record<string, boolean>[] = [{}, { applied: false }, { valid: true }];
  for (const result of unacknowledged) {
    port.request = async (request) => ({ type: "res", cmd_id: request.cmd_id, ok: true, result });
    await assert.rejects(transport.apply("policy", defaultPolicy(), false), /Runner settings/);
  }
  port.request = async (request) => ({ type: "res", cmd_id: request.cmd_id, ok: true, result: { applied: true } });
  await assert.rejects(transport.preflight!("policy", defaultPolicy(), false), /Runner settings/);
  port.request = async (request) => ({ type: "res", cmd_id: request.cmd_id, ok: false, error: "unavailable" });
  await assert.rejects(transport.apply("policy", defaultPolicy(), false), /Runner settings/);
});

test("redaction changes record field names only and Keychain failures never echo values", async () => {
  const f = await createFixture();
  try {
    const secret = "private-secret-pattern";
    await f.service.write("config", { storage: { redaction: { patterns: [secret] } } });
    assert.ok(!JSON.stringify(f.ledger.readSince(0, 100)).includes(secret));
    f.options.keychain.setClaudeApiKey = async () => { throw new TypeError(secret); };
    const response = await f.service.handle({ type: "cmd", cmd_id: "rejected-key", command: "settings.apiKey", payload: { value: secret } });
    assert.equal(response.ok, false); assert.ok(!JSON.stringify(response).includes(secret));
    f.options.keychain.hasClaudeApiKey = async () => { throw new TypeError(secret); };
    const readFailure = await f.service.handle({ type: "cmd", cmd_id: "key-status-error", command: "settings.read" });
    assert.equal(readFailure.ok, false); assert.ok(!JSON.stringify(readFailure).includes(secret));
    const before = await readFile(f.paths.config, "utf8");
    f.options.preflight = async () => { throw new Error("Runner rejected"); };
    await assert.rejects(f.service.write("config", { dashboard: { port: 7590 } }));
    assert.equal(await readFile(f.paths.config, "utf8"), before);
  } finally { await f.close(); }
});

test("storage narrowing affects future settings and retains existing payloads", async () => {
  const f = await createFixture();
  try {
    f.ledger.append({ source: "ui", source_event_id: "existing-message", kind: "message.created", subject: "message:existing", source_ts: new Date().toISOString(), confidence: "confirmed", payload: { provider: "claude", native_id: "existing", version: 1, role: "user", body: "existing body", body_state: "stored" } });
    const response = await f.service.handle({ type: "cmd", cmd_id: "narrow", command: "settings.write", payload: { store: "config", patch: { storage: { scope: "metadata" } } } });
    assert.match(JSON.stringify(response), /requires_confirmation/);
    assert.equal(f.service.read("config").storage.scope, "metadata");
    assert.match(JSON.stringify(f.ledger.readSince(0, 100)), /existing body/);
  } finally { await f.close(); }
});

test("runner errors never expose secrets in responses or file watch errors", async () => {
  const f = await createFixture();
  try {
    const secret = "private-runner-api-key";
    await f.service.write("config", { dashboard: { port: 7570 } });
    const original = await readFile(f.paths.config, "utf8");
    for (const operation of ["preflight", "apply"] as const) {
      f.options.preflight = async () => {};
      f.options.apply = async () => {};
      f.options[operation] = async (_store, value) => {
        if ("dashboard" in value && value.dashboard.port === 7571) throw new TypeError(secret);
      };
      const response = await f.service.handle({ type: "cmd", cmd_id: `runner-error-${operation}`, command: "settings.write", payload: { store: "config", patch: { dashboard: { port: 7571 } } } });
      assert.equal(response.ok, false);
      assert.ok(!JSON.stringify(response).includes(secret));
      assert.equal(await readFile(f.paths.config, "utf8"), original);
      assert.equal(f.service.read("config").dashboard.port, 7570);
    }
    let reason = "";
    f.options.onError = (_store, error) => { reason = error; };
    await writeFile(f.paths.config, '[dashboard]\nport = 7571\n');
    await waitUntil(() => !!reason);
    assert.equal(reason, "Settings application failed");
    assert.equal(f.service.read("config").dashboard.port, 7570);
    assert.ok(!JSON.stringify(await f.service.handle({ type: "cmd", cmd_id: "read-runner-error", command: "settings.read" })).includes(secret));
    assert.ok(!JSON.stringify(f.ledger.readSince(0, 100)).includes(secret));
  } finally { await f.close(); }
});

test("unobserved manual edits cannot be overwritten by a policy preview or a config save", async () => {
  const f = await createFixture();
  try {
    f.service.close();
    const patch = { quota: { hardLimitPercent: 95 } };
    const preview = f.service.previewPolicy(patch);
    const policyText = '[quota]\nhardLimitPercent = 80 # manual decision\n';
    await writeFile(f.paths.policy, policyText);
    await assert.rejects(f.service.write("policy", patch, { previewToken: preview.token }), /file changed/);
    assert.equal(await readFile(f.paths.policy, "utf8"), policyText);
    assert.equal(f.service.read("policy").quota.hardLimitPercent, 90);
    const configText = '[dashboard]\nport = 7550 # manual decision\n';
    await writeFile(f.paths.config, configText);
    await assert.rejects(f.service.write("config", { dashboard: { port: 7551 } }), /file changed/);
    assert.equal(await readFile(f.paths.config, "utf8"), configText);
    assert.equal(f.ledger.readSince(0, 100).length, 0);
    await f.service.reload("policy");
    const fresh = f.service.previewPolicy(patch);
    await f.service.write("policy", patch, { previewToken: fresh.token });
    assert.equal(f.service.read("policy").quota.hardLimitPercent, 95);
  } finally { await f.close(); }
});

test("failed audit restores runner settings for both saved and watched changes", async () => {
  const f = await createFixture();
  const append = f.ledger.append;
  try {
    f.service.close();
    await f.service.write("config", { dashboard: { port: 7550 } });
    const before = await readFile(f.paths.config, "utf8");
    let runtimePort = 7550;
    f.options.apply = async (_store, value) => { if ("dashboard" in value) runtimePort = value.dashboard.port; };
    f.ledger.append = () => { throw new TypeError("private-audit-secret"); };
    await assert.rejects(f.service.write("config", { dashboard: { port: 7551 } }), /audit failed/);
    assert.equal(await readFile(f.paths.config, "utf8"), before);
    assert.equal(runtimePort, 7550);
    await writeFile(f.paths.config, '[dashboard]\nport = 7552\n');
    await f.service.reload("config");
    assert.equal(runtimePort, 7550);
    assert.equal(f.service.read("config").dashboard.port, 7550);
    const response = await f.service.handle({ type: "cmd", cmd_id: "audit-read", command: "settings.read" });
    assert.ok(!JSON.stringify(response).includes("private-audit-secret"));
  } finally { f.ledger.append = append; await f.close(); }
});

test("authenticated WebSocket serves Settings commands without an available runner", { timeout: 5000 }, async (t) => {
  const { WebSocket } = await import("ws");
  const { startSettingsWebSocketServer } = await import("../src/settings/websocket.ts");
  const { openObservationService } = await import("../src/service/index.ts");
  const f = await createFixture();
  const observation = openObservationService({ dbPath: join(f.root, "ledger.db") });
  let server: Awaited<ReturnType<typeof startSettingsWebSocketServer>> | undefined;
  let socket: InstanceType<typeof WebSocket> | undefined;
  try {
    try { server = await startSettingsWebSocketServer(observation, f.service, { port: 0, runnerPath: join(f.root, "absent.sock") }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EPERM" && "syscall" in error && error.syscall === "listen")) throw error;
      t.skip("sandbox blocks local TCP socket listen"); return;
    }
    socket = new WebSocket(`${server.wsUrl}?token=${server.token}`, { origin: server.url });
    const responses = new Map<string, { ok: boolean; result?: { apiKeyConfigured?: boolean; saved?: boolean } }>();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "ack") responses.set(message.cmd_id, message);
    });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    socket.send(JSON.stringify({ type: "hello", seq: 0 }));
    socket.send(JSON.stringify({ type: "cmd", cmd_id: "socket-read", command: "settings.read" }));
    await waitUntil(() => responses.has("socket-read"));
    assert.equal(responses.get("socket-read")?.ok, true);
    assert.equal(responses.get("socket-read")?.result?.apiKeyConfigured, false);
    socket.send(JSON.stringify({ type: "cmd", cmd_id: "socket-write", command: "settings.write", payload: { store: "config", patch: { dashboard: { port: 7550 } } } }));
    await waitUntil(() => responses.has("socket-write"));
    assert.equal(responses.get("socket-write")?.result?.saved, true);
    assert.equal(f.service.read("config").dashboard.port, 7550);
  } finally {
    socket?.terminate();
    await server?.close();
    observation.close();
    await f.close();
  }
});
