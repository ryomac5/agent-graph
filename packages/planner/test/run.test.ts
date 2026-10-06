import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import type { DelegateRequest, DelegateResult } from "../../core/src/index.ts";
import { connectIntake, createPlannerRequestId } from "../src/intake-client.ts";
import { serve, respond } from "./fake-runner.ts";
import { openPlanner, requestDecision, runGraph } from "../src/run.ts";

function git(repo: string, ...args: string[]) { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function fixture(t: TestContext, tasks: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "planner-run-")));
  const previous = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.XDG_STATE_HOME = join(repo, "state");
  process.env.XDG_CACHE_HOME = join(repo, "cache");
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(repo, { recursive: true, force: true }); });
  git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "commit", "--allow-empty", "-m", "initial");
  const specPath = join(repo, "tasks.yaml");
  writeFileSync(specPath, `goal: fixture\nbase_branch: main\ntasks:\n${tasks}`);
  return { repo, session: "s1", specPath, noPr: true, maxParallel: 2 };
}
function worker(id: string, deps = "[]", executor = "codex") { return `  - id: ${id}\n    title: ${id}\n    executor: ${executor}\n    depends_on: ${deps}\n    scope: [${id}.txt]\n    outputs: [${id}.txt]\n    accept: ["test -f ${id}.txt"]\n    prompt: write ${id}\n    model: ${executor === "codex" ? "gpt-6-sol" : "sonnet"}\n`; }
function result(status = "done"): DelegateResult { return { delegationId: "fake", status, roundTrips: 0 } as DelegateResult; }
async function waitState(options: ReturnType<typeof fixture>, id: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const ctx = openPlanner(options.repo, options.session, options.specPath);
    try { const graph = ctx.store.findGraph(ctx.key, options.session, ctx.fingerprint); if (graph && ctx.store.listTasks(graph.id).some((task) => task.id === id && task.state === state)) return; }
    finally { ctx.store.close(); }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${id}: ${state}`);
}

test("並列実行、依存、承認、scope 限定統合と同一指紋の再開", async (t) => {
  const options = fixture(t, worker("a") + worker("b", "[a]") + worker("c", "[]", "doc-light") +
    "  - id: gate\n    title: gate\n    executor: human\n    depends_on: [b, c]\n  - id: pr\n    title: pr\n    executor: pr\n    depends_on: [gate]\n");
  const requests: DelegateRequest[] = [];
  let active = 0; let peak = 0;
  const connect = async () => ({ close() {}, async delegate(request: DelegateRequest) {
    requests.push(request); peak = Math.max(peak, ++active);
    if (request.title === "b") assert.ok(existsSync(join(request.cwd!, "a.txt")));
    writeFileSync(join(request.cwd!, `${request.title}.txt`), request.title);
    writeFileSync(join(request.cwd!, "generated.tmp"), "excluded");
    await delay(50); active--; return result();
  } });
  const running = runGraph(options, { connect });
  await waitState(options, "gate", "waiting_human");
  requestDecision(options, "gate", "approve");
  const completed = await running;
  assert.equal(peak, 2);
  assert.ok(completed.tasks.every((task) => task.state === "done"));
  assert.deepEqual(completed.tasks.map((task) => task.attempts), [1, 1, 1, 0, 0]);
  assert.deepEqual(requests.map((request) => request.role), ["implement", "document", "implement"]);
  assert.deepEqual(requests.map((request) => request.review), [true, false, true]);
  assert.deepEqual(requests.map((request) => request.constraints), [
    { excludeFamily: ["anthropic"], minTier: "mid" },
    { excludeFamily: ["openai"], minTier: "mid" },
    { excludeFamily: ["anthropic"], minTier: "mid" },
  ]);
  assert.equal(existsSync(join(completed.integration, "generated.tmp")), false);
  for (const name of ["a", "b", "c"]) assert.equal(readFileSync(join(completed.integration, `${name}.txt`), "utf8"), name);
  const resumed = await runGraph(options, { connect });
  assert.equal(resumed.graph.id, completed.graph.id); assert.equal(requests.length, 3);
  const ctx = openPlanner(options.repo, options.session, options.specPath);
  assert.equal(ctx.store.listGraphEvents(completed.graph.id, "model.ignored").length, 0);
  assert.deepEqual(ctx.store.listGraphEvents(completed.graph.id, "model.constrained").map((event) => event.payload.constraints),
    requests.map((request) => request.constraints));
  ctx.store.close();
  writeFileSync(options.specPath, `goal: different\nbase_branch: main\ntasks:\n${worker("a")}`);
  const changed = await runGraph(options, { connect });
  assert.notEqual(changed.graph.id, completed.graph.id);
  assert.equal(existsSync(join(changed.integration, "b.txt")), false);
});

test("変換できない model は実行だけ拒否し、status と判断は利用できる", async (t) => {
  const options = fixture(t, worker("a").replace("model: gpt-6-sol", "model: unknown") + "    review_model: fable\n");
  let connected = false;
  const connect = async () => { connected = true; return { close() {}, async delegate() { return result(); } }; };
  await assert.rejects(runGraph(options, { connect }), /Unsupported model "unknown"/);
  assert.equal(connected, false);
  const ctx = openPlanner(options.repo, options.session, options.specPath);
  const graph = { id: "existing", repoKey: ctx.key, sessionId: options.session, goal: ctx.spec.goal,
    fingerprint: ctx.fingerprint, createdAt: new Date().toISOString() };
  ctx.store.upsertRepo({ key: ctx.key, rootPath: ctx.root, name: "fixture" });
  ctx.store.insertSession({ id: options.session, repoKey: ctx.key, name: options.session, client: "planner",
    traceId: "fixture", startedAt: graph.createdAt });
  ctx.store.insertGraph(graph, [{ graphId: graph.id, id: "a", title: "a", role: "implement",
    dependsOn: [], state: "waiting_human", attempts: 2 }]);
  ctx.store.close();
  const output = execFileSync(process.execPath, [new URL("../src/cli.ts", import.meta.url).pathname, "status", "--session", options.session, "--spec", options.specPath],
    { cwd: options.repo, encoding: "utf8", env: process.env });
  assert.equal(JSON.parse(output).graph.id, graph.id);
  requestDecision(options, "a", "approve");
  requestDecision(options, "a", "reject");
  const reopened = openPlanner(options.repo, options.session, options.specPath);
  assert.deepEqual(reopened.store.listTaskDecisions(graph.id).map((decision) => decision.action), ["approve", "reject"]);
  reopened.store.close();
});

test("review_model を記録し、委譲と承認を継続する", async (t) => {
  const options = fixture(t, worker("a", "[gate]") + "    review_model: fable\n" +
    "  - id: gate\n    title: gate\n    executor: human\n");
  const running = runGraph(options, { connect: async () => ({ close() {}, async delegate(request) {
    assert.deepEqual(request.constraints, { excludeFamily: ["anthropic"], minTier: "mid" });
    writeFileSync(join(request.cwd!, "a.txt"), "a"); return result();
  } }) });
  await waitState(options, "gate", "waiting_human");
  requestDecision(options, "gate", "approve");
  const completed = await running;
  assert.ok(completed.tasks.every((task) => task.state === "done"));
  const ctx = openPlanner(options.repo, options.session, options.specPath);
  const ignored = ctx.store.listGraphEvents(completed.graph.id, "model.ignored");
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].payload.taskId, "a");
  assert.equal(ignored[0].payload.review_model, "fable");
  assert.match(String(ignored[0].payload.reason), /レビュアー/);
  ctx.store.close();
});

test("delegate の失敗は nextAttempt で再試行して昇格し、retry と reject は旧版の状態語彙を保つ", async (t) => {
  const options = fixture(t, worker("a"));
  let failed = true;
  const connect = async () => ({ close() {}, async delegate(request: DelegateRequest) {
    writeFileSync(join(request.cwd!, "a.txt"), "a"); return result(failed ? "failed" : "done");
  } });
  const running = runGraph(options, { connect });
  // 既定の retry.max=1 で 1 回自動再試行した後、waiting_human に昇格する
  await waitState(options, "a", "waiting_human");
  requestDecision(options, "a", "retry"); failed = false;
  const first = await running;
  assert.equal(first.tasks[0].state, "done"); assert.equal(first.tasks[0].attempts, 3);
  writeFileSync(options.specPath, "goal: gate\ntasks:\n  - id: gate\n    title: gate\n    executor: human\n");
  const gate = runGraph(options);
  await waitState(options, "gate", "waiting_human"); requestDecision(options, "gate", "reject");
  assert.equal((await gate).tasks[0].state, "rejected");
});

test("マージ衝突は conflict で待機し reject で終了する", async (t) => {
  const options = fixture(t, (worker("a") + worker("b")).replaceAll(/scope: \[[ab].txt\]/g, "scope: [shared.txt]"));
  const running = runGraph(options, { connect: async () => ({ close() {}, async delegate(request) {
    writeFileSync(join(request.cwd!, "shared.txt"), request.title); await delay(request.title === "a" ? 20 : 50); return result();
  } }) });
  await waitState(options, "b", "conflict"); requestDecision(options, "b", "reject");
  assert.deepEqual((await running).tasks.map((task) => task.state), ["done", "rejected"]);
});

test("既存の scope 内コミットを統合し、受け入れの生成物は残す", async (t) => {
  const options = fixture(t, worker("a"));
  const completed = await runGraph(options, { connect: async () => ({ close() {}, async delegate(request) {
    writeFileSync(join(request.cwd!, "a.txt"), "a");
    git(request.cwd!, "add", "a.txt"); git(request.cwd!, "commit", "-m", "child commit");
    writeFileSync(join(request.cwd!, "generated.tmp"), "excluded");
    return result();
  } }) });
  assert.equal(completed.tasks[0].state, "done");
  assert.equal(readFileSync(join(completed.integration, "a.txt"), "utf8"), "a");
  assert.equal(existsSync(join(completed.integration, "generated.tmp")), false);
});

test("scope 内の変更もコミットも無い生成物だけの結果は failed", async (t) => {
  const options = fixture(t, worker("a"));
  const completed = await runGraph(options, { connect: async () => ({ close() {}, async delegate(request) {
    writeFileSync(join(request.cwd!, "generated.tmp"), "excluded"); return result();
  } }) });
  assert.equal(completed.tasks[0].state, "failed");
  assert.equal(existsSync(join(completed.integration, "generated.tmp")), false);
});

test("子が scope 外までコミットした場合は統合しない", async (t) => {
  const options = fixture(t, worker("a"));
  const completed = await runGraph(options, { connect: async () => ({ close() {}, async delegate(request) {
    writeFileSync(join(request.cwd!, "a.txt"), "a");
    writeFileSync(join(request.cwd!, "outside.txt"), "outside");
    git(request.cwd!, "add", "."); git(request.cwd!, "commit", "-m", "outside scope");
    return result();
  } }) });
  assert.equal(completed.tasks[0].state, "failed");
  assert.equal(existsSync(join(completed.integration, "outside.txt")), false);
});

for (const state of ["waiting_human", "conflict"] as const) test(
  `human retry from ${state} sends a new requestId to intake`, async (t) => {
    const tasks = state === "waiting_human" ? worker("a") :
      (worker("a") + worker("b")).replaceAll(/scope: \[[ab].txt\]/g, "scope: [shared.txt]");
    const options = fixture(t, tasks);
    const taskId = state === "waiting_human" ? "a" : "b";
    let retried = false;
    const cached = new Map<string, unknown>();
    const runner = await serve(t, (frame, socket) => {
      assert.equal(frame.command, "intake.submit");
      const request = frame.payload;
      if (!cached.has(request.requestId)) {
        writeFileSync(join(request.cwd, state === "conflict" ? "shared.txt" : "a.txt"), request.title);
        const status = state === "waiting_human" && !retried ? "failed" : "done";
        cached.set(request.requestId, { requestId: request.requestId, state: status, attempt: 1,
          result: { ...result(status), delegationId: request.requestId } });
      }
      if (state === "conflict" && request.title === "b") {
        setTimeout(() => respond(socket, frame, cached.get(request.requestId)), 100);
      } else respond(socket, frame, cached.get(request.requestId));
    });
    const running = runGraph(options, { connect: (connectionOptions) => connectIntake({ ...connectionOptions,
      socketPath: runner.path, connectSocket: runner.connectSocket }) });
    await waitState(options, taskId, state);
    const before = runner.frames.filter((frame) => frame.command === "intake.submit" && frame.payload.title === taskId);
    assert.equal(before.length, state === "waiting_human" ? 2 : 1);
    retried = true;
    requestDecision(options, taskId, "retry");
    for (let i = 0; i < 150; i++) {
      if (runner.frames.filter((frame) => frame.command === "intake.submit" && frame.payload.title === taskId).length > before.length) break;
      await delay(20);
    }
    const after = runner.frames.filter((frame) => frame.command === "intake.submit" && frame.payload.title === taskId);
    assert.equal(after.length, before.length + 1);
    assert.equal(new Set(after.map((frame) => frame.payload.requestId)).size, after.length);
    if (state === "conflict") {
      await waitState(options, taskId, "conflict");
      requestDecision(options, taskId, "reject");
    }
    const completed = await running;
    const task = completed.tasks.find((task) => task.id === taskId)!;
    assert.equal(task.attempts, after.length);
    assert.equal(task.state, state === "conflict" ? "rejected" : "done");
    assert.deepEqual(after.map((frame) => frame.payload.requestId),
      after.map((_, index) => createPlannerRequestId(completed.graph.id, taskId, index + 1)));
  });
