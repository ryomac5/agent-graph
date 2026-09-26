import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { openStore, type GraphRecord, type Store } from "../../core/src/index.ts";
import { markApplied, pendingDecisions, recordDecision } from "../src/decisions.ts";
import { openPlanner, runGraph } from "../src/run.ts";

const startedAt = "2026-09-25T00:00:00.000Z";

function memoryFixture(): { store: Store; graph: GraphRecord } {
  const store = openStore(":memory:");
  store.upsertRepo({ key: "repo", rootPath: "/repo", name: "repo" });
  store.insertSession({ id: "s1", repoKey: "repo", name: "repo-001", client: "planner", traceId: "a".repeat(32), startedAt });
  const graph: GraphRecord = { id: "G1", repoKey: "repo", sessionId: "s1", goal: "goal", fingerprint: "f", createdAt: startedAt };
  store.insertGraph(graph, [
    { graphId: "G1", id: "gate", title: "gate", role: "human", dependsOn: [], state: "waiting_human", attempts: 0 },
    { graphId: "G1", id: "broken", title: "broken", role: "implement", dependsOn: [], state: "failed", attempts: 1 },
    { graphId: "G1", id: "work", title: "work", role: "implement", dependsOn: [], state: "running", attempts: 1 },
  ]);
  return { store, graph };
}

test("recordDecision は状態を検べて表に書き、pendingDecisions は未適用だけ返す", (t) => {
  const { store, graph } = memoryFixture();
  t.after(() => store.close());
  const now = new Date("2026-09-25T01:00:00.000Z");
  recordDecision(store, graph, "gate", "approve", now);
  recordDecision(store, graph, "broken", "retry", now);
  assert.throws(() => recordDecision(store, graph, "broken", "approve"), /not waiting \(state: failed\)/);
  assert.throws(() => recordDecision(store, graph, "work", "retry"), /not waiting/);
  assert.throws(() => recordDecision(store, graph, "nope", "approve"), /Task not found/);
  const pending = pendingDecisions(store, graph);
  assert.deepEqual(pending.map(({ taskId, action, at }) => ({ taskId, action, at })),
    [{ taskId: "gate", action: "approve", at: now.toISOString() }, { taskId: "broken", action: "retry", at: now.toISOString() }]);
  markApplied(store, graph, pending[0], "applied");
  assert.deepEqual(pendingDecisions(store, graph).map((row) => row.taskId), ["broken"]);
  assert.equal(store.listGraphEvents("G1", "decision.applied")[0].payload.decisionId, pending[0].id);
});

function repoFixture(t: TestContext, tasks: string) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "planner-decisions-")));
  const previous = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.XDG_STATE_HOME = join(repo, "state");
  process.env.XDG_CACHE_HOME = join(repo, "cache");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(repo, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "initial");
  const specPath = join(repo, "tasks.yaml");
  writeFileSync(specPath, `goal: decisions\nbase_branch: main\ntasks:\n${tasks}`);
  return { repo, session: "s1", specPath, noPr: true };
}

// ダッシュボードと同じ経路。別の接続から task_decisions に書く。
async function decideFromOutside(options: ReturnType<typeof repoFixture>, taskId: string, action: string, waitFor: string) {
  for (let i = 0; i < 100; i++) {
    const ctx = openPlanner(options.repo, options.session, options.specPath);
    try {
      const graph = ctx.store.findGraph(ctx.key, options.session, ctx.fingerprint);
      if (graph && ctx.store.getTask(graph.id, taskId)?.state === waitFor) {
        ctx.store.insertTaskDecision(graph.id, taskId, action, new Date().toISOString());
        return graph.id;
      }
    } finally { ctx.store.close(); }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${taskId}: ${waitFor}`);
}

test("planner は表の approve を 1 秒以内に拾って人のタスクを done にする", { timeout: 15_000 }, async (t) => {
  const options = repoFixture(t, "  - id: gate\n    title: gate\n    executor: human\n");
  const running = runGraph(options);
  const graphId = await decideFromOutside(options, "gate", "approve", "waiting_human");
  const result = await running;
  assert.equal(result.tasks[0].state, "done");
  const ctx = openPlanner(options.repo, options.session, options.specPath);
  try {
    assert.equal(pendingDecisions(ctx.store, ctx.store.getGraph(graphId)!).length, 0);
    assert.equal(ctx.store.listGraphEvents(graphId, "decision.applied")[0].payload.effect, "applied");
  } finally { ctx.store.close(); }
});

test("planner は表の reject を却下にし、failed の retry を再実行にする", { timeout: 15_000 }, async (t) => {
  const options = repoFixture(t, "  - id: gate\n    title: gate\n    executor: human\n");
  const rejected = runGraph(options);
  await decideFromOutside(options, "gate", "reject", "waiting_human");
  assert.equal((await rejected).tasks[0].state, "rejected");

  writeFileSync(options.specPath, "goal: retry\nbase_branch: main\ntasks:\n  - id: a\n    title: a\n    executor: codex\n    scope: [a.txt]\n    outputs: [a.txt]\n    accept: [\"test -f a.txt\"]\n    prompt: write a\n");
  let failed = true;
  const connect = async () => ({ close() {}, async delegate(request: { cwd?: string }) {
    writeFileSync(join(request.cwd!, "a.txt"), "a");
    return { delegationId: "fake", status: failed ? "failed" : "done", roundTrips: 0 } as never;
  } });
  // 既定の retry.max=1 で 1 回自動再試行し、失敗し続ければ waiting_human に昇格する
  const running = runGraph(options, { connect });
  await decideFromOutside(options, "a", "retry", "waiting_human");
  failed = false;
  const first = await running;
  assert.equal(first.tasks[0].state, "done");
  assert.equal(first.tasks[0].attempts, 1);
  // 状態が合わない判断は反映せず skipped と記録する
  const after = openPlanner(options.repo, options.session, options.specPath);
  try { after.store.insertTaskDecision(first.graph.id, "a", "approve", new Date().toISOString()); } finally { after.store.close(); }
  const third = await runGraph(options, { connect });
  assert.equal(third.tasks[0].state, "done");
  const check = openPlanner(options.repo, options.session, options.specPath);
  try {
    const applied = check.store.listGraphEvents(first.graph.id, "decision.applied");
    assert.deepEqual(applied.map((event) => event.payload.effect), ["applied", "skipped"]);
  } finally { check.store.close(); }
});
