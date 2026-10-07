import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { forwardScreenCommand } from "../../api/src/ws/commands.ts";
import { observeKitDelegationsFile } from "../../api/src/observe/kit/index.ts";
import { observeCodexFile } from "../../api/src/observe/codex/index.ts";
import { startShim } from "../../adapters/src/shim-v2/index.ts";
import { connectIntake, createPlannerRequestId } from "../../planner/src/intake-client.ts";
import { project, projectDelegations, projectRelations, rebuild } from "../../core/src/ledger/index.ts";
import { fixture, messages, until } from "./samples/S13/fixture.ts";

const PARENT_NATIVE = "s5-parent";
function seedParent(f: ReturnType<typeof fixture>) {
  f.ledger.append({ source: "hook", source_event_id: "parent", source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed",
    kind: "conversation.created", subject: "conversation:parent", payload: { provider: "codex", native_id: PARENT_NATIVE,
      origin: "observed", type: "interactive", history_format: "jsonl" } });
}
function createShim(f: ReturnType<typeof fixture>) {
  const input = new PassThrough(); const output = new PassThrough(); const replies = messages(output);
  const shim = startShim({ path: "memory", input, output, env: { CODEX_THREAD_ID: PARENT_NATIVE }, connect() {
    const { client } = f.connect(); queueMicrotask(() => client.emit("connect")); return client;
  } });
  return { input, replies, close() { shim.close(); input.destroy(); output.destroy(); } };
}

test("screen cmd, MCP and planner use one intake, with idempotent submissions and explicit retry", async (t) => {
  const f = fixture(t); seedParent(f);
  const api = f.connect(); const replies = messages(api.client);
  api.client.write(JSON.stringify({ type: "hello", version: 1, role: "api" }) + "\n");
  const command = forwardScreenCommand({ type: "cmd", cmd_id: "screen", command: "intake.submit",
    payload: { ...f.request, origin: { provider: "codex", nativeId: PARENT_NATIVE } } });
  api.client.write(JSON.stringify(command) + "\n");
  await until(() => replies.some((r) => r.cmd_id === "screen"));
  const uiId = replies.find((r) => r.cmd_id === "screen").result.requestId;
  assert.equal(uiId, 'ui:["screen"]');
  api.client.write(JSON.stringify(command) + "\n");
  const shim = createShim(f); t.after(() => shim.close());
  shim.input.write(JSON.stringify({ jsonrpc: "2.0", id: "mcp", method: "tools/call", params: { name: "delegate", arguments: f.request } }) + "\n");
  await until(() => shim.replies.some((r) => r.id === "mcp"));
  const mcpId = shim.replies.find((r) => r.id === "mcp").result.structuredContent.requestId;
  const planner = await connectIntake({ cwd: f.request.cwd!, env: { CODEX_THREAD_ID: PARENT_NATIVE, CLAUDE_CODE_SESSION_ID: "", AGENT_GRAPH_MANAGED: "" },
    connectSocket() { const { client } = f.connect(); queueMicrotask(() => client.emit("connect")); return client; } });
  t.after(() => planner.close());
  const plannerId = createPlannerRequestId("graph", "task", 1);
  await planner.submit({ ...f.request, requestId: plannerId });
  await until(() => f.host.starts.length === 3);
  const creations = f.ledger.readSince(0, 1000).filter((fact) => fact.kind === "delegation.created");
  assert.deepEqual(creations.map((fact) => (fact.payload as unknown as { request: { source: string } }).request.source).sort(), ["mcp", "planner", "ui"]);
  for (const start of f.host.starts) f.host.emit(start.runId, { type: "exit", exitCode: 1 });
  await Promise.all([uiId, mcpId, plannerId].map((id) => f.intake.wait(id)));
  const retry = forwardScreenCommand({ type: "cmd", cmd_id: "retry", command: "intake.retry", payload: { requestId: uiId } });
  api.client.write(JSON.stringify(retry) + "\n");
  await until(() => replies.some((r) => r.cmd_id === "retry") && f.host.starts.length === 4);
  assert.equal(replies.find((r) => r.cmd_id === "retry").result.attempt, 2);
  f.host.emit(f.host.starts[3].runId, { type: "exit", exitCode: 1 }); await f.intake.wait(uiId);
  assert.equal(projectDelegations(f.ledger.readSince(0, 1000)).length, 3);
  const relations = projectRelations(f.ledger.readSince(0, 1000));
  assert.equal(relations.length, 4);
  assert.ok(relations.every((r) => r.type === "delegated" && r.confidence === "confirmed" && r.from_id === JSON.stringify(["codex", PARENT_NATIVE])));
});

for (const entry of ["agc", "mcp", "native"] as const) test(`S5: ${entry} produces the same confirmed parent/child relation`, async (t) => {
  const f = fixture(t); seedParent(f);
  let childId = JSON.stringify(["codex", "s5-child"]);
  const samples = new URL("./samples/S5/", import.meta.url);
  const expected = JSON.parse(readFileSync(new URL("expected.json", samples), "utf8"));
  if (entry === "mcp") {
    const shim = createShim(f); t.after(() => shim.close());
    const input = JSON.parse(readFileSync(new URL("mcp.json", samples), "utf8"));
    input.params.arguments.cwd = f.request.cwd;
    shim.input.write(JSON.stringify(input) + "\n");
    await until(() => f.host.starts.length === 1 && shim.replies.some((r) => r.id === input.id));
    const requestId = shim.replies.find((r) => r.id === input.id).result.structuredContent.requestId;
    const run = f.host.starts[0]; childId = JSON.stringify(["codex", run.runId]);
    f.host.emit(run.runId, { type: "exit", exitCode: 1 }); await f.intake.wait(requestId);
    const count = f.ledger.readSince(0, 1000).length;
    const saved = (f.ledger.readSince(0, 1000).find((fact) => fact.kind === "delegation.created")!.payload as unknown as { request: unknown }).request;
    const replay = f.connect(); const responses = messages(replay.client);
    replay.client.write(JSON.stringify({ type: "hello", version: 1, role: "mcp" }) + "\n");
    replay.client.write(JSON.stringify({ ...input, params: { ...input.params, arguments: saved } }) + "\n");
    await until(() => responses.some((r) => r.id === input.id));
    assert.equal(f.ledger.readSince(0, 1000).length, count); assert.equal(f.host.starts.length, 1);
  } else {
    const path = join(f.directory, `${entry}.jsonl`);
    writeFileSync(path, readFileSync(new URL(`${entry}.jsonl`, samples)));
    if (entry === "agc") f.ledger.append({ source: "hook", source_event_id: "child", source_ts: "2026-01-01T00:00:00Z", confidence: "confirmed",
      kind: "conversation.created", subject: `conversation:${childId}`, payload: { provider: "codex", native_id: "s5-child", origin: "observed", type: "subagent", history_format: "jsonl" } });
    const ingest = () => entry === "agc" ? observeKitDelegationsFile(f.ledger, path) : observeCodexFile(f.ledger, path);
    ingest(); const count = f.ledger.readSince(0, 1000).length; ingest();
    assert.equal(f.ledger.readSince(0, 1000).length, count);
    await f.intake.recover(); assert.equal(f.host.starts.length, 0);
  }
  const facts = f.ledger.readSince(0, 1000);
  const expectedLedger = JSON.parse(readFileSync(new URL("expected-ledger.json", samples), "utf8"));
  for (const [kind, count] of Object.entries(expectedLedger[entry])) assert.equal(facts.filter((fact) => fact.kind === kind).length, count);
  const relation = projectRelations(facts)[0];
  assert.deepEqual({ type: relation.type, from_id: relation.from_id === JSON.stringify(["codex", PARENT_NATIVE]) ? "parent" : relation.from_id,
    to_id: relation.to_id === childId ? "child" : relation.to_id, confidence: relation.confidence, active: relation.active }, expected.relation);
  assert.deepEqual(project([...facts].reverse()), project(facts));
  const db = new DatabaseSync(join(f.directory, "ledger.db"));
  try {
    rebuild(db);
    const first = db.prepare("SELECT * FROM relations ORDER BY id").all();
    rebuild(db);
    assert.deepEqual(db.prepare("SELECT * FROM relations ORDER BY id").all(), first);
    assert.equal(first.length, 1);
    assert.equal(first[0].type, expected.relation.type);
    assert.equal(first[0].from_id, relation.from_id);
    assert.equal(first[0].to_id, relation.to_id);
    assert.equal(first[0].confidence, expected.relation.confidence);
  } finally { db.close(); }
});

test("runner owns planner execution and terminates a job waiting for a human", { timeout: 10_000 }, async (t) => {
  const { RunnerPlanner } = await import("../src/planner.ts");
  const f = fixture(t);
  const planner = new RunnerPlanner("memory"); t.after(() => planner.close());
  const specPath = join(f.directory, "planner.yaml");
  writeFileSync(specPath, "goal: Fixture\nbase_branch: main\ntasks:\n  - id: PR\n    title: Skipped PR\n    executor: pr\n");
  const started = planner.command({ type: "req", cmd_id: "graph", command: "planner.run", payload: { cwd: f.request.cwd!, session: "fixture", specPath } });
  assert.deepEqual(started, { jobId: "graph", state: "running" });
  const status = () => planner.command({ type: "req", cmd_id: "status", command: "planner.status", payload: { jobId: "graph" } }) as { state: string; output: string; error: string };
  await until(() => status().state !== "running");
  assert.equal(status().state, "failed");
  assert.match(status().error, /human/);
  writeFileSync(specPath, "goal: Fixture\nbase_branch: main\ntasks:\n  - id: human\n    title: Wait\n    executor: human\n");
  planner.command({ type: "req", cmd_id: "waiting", command: "planner.run", payload: { cwd: f.request.cwd!, session: "waiting", specPath } });
  await new Promise<void>((done) => setTimeout(done, 100));
  await planner.close();
  assert.equal((planner.command({ type: "req", cmd_id: "status", command: "planner.status", payload: { jobId: "waiting" } }) as { state: string }).state, "failed");
});

test("fake e2e hosts finish acceptance and review with a saved done result", { timeout: 10_000 }, async (t) => {
  const { CompletingHost } = await import("../src/e2e-intake.ts");
  const { RunnerRuntime } = await import("../src/runtime.ts");
  const { Intake } = await import("../src/intake/index.ts");
  const f = fixture(t); seedParent(f);
  const hosts = [new CompletingHost("codex"), new CompletingHost("claude")];
  const runtime = new RunnerRuntime(f.ledger, hosts, () => {}, "shared");
  const intake = new Intake(f.ledger, runtime, { cwd: f.request.cwd });
  const request = { ...f.request, requestId: "e2e-fake", accept: ["git diff --exit-code"], origin: { provider: "codex" as const, nativeId: PARENT_NATIVE } };
  try {
    assert.equal(intake.submit(request).state, "accepted");
    assert.equal((await intake.wait(request.requestId)).state, "done");
    assert.equal(hosts[0].starts.length, 1); assert.equal(hosts[1].starts.length, 1);
    assert.equal(intake.submit(request).result!.review!.verdict, "approve");
  } finally { await intake.close(); }
});
