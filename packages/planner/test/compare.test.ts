import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore } from "../../core/src/store/store.ts";
import { repoKey, stateDbPath } from "../../core/src/paths.ts";
import { compareRuns, loadLegacyState, loadPlannerState } from "../src/compare.ts";

const cli = join(import.meta.dirname, "../src/cli.ts");
const fixtureState = {
  _meta: { base_branch: "main", fingerprint: "fixture", goal: "導入と比較" },
  I1: { state: "running", attempts: 1, executor: "codex", model: "gpt-6-sol" },
  I3: { state: "running", attempts: 1, executor: "codex", model: "gpt-6-sol" },
  I2: { state: "planned", attempts: 0, executor: "", model: "" },
  G9: { state: "planned", attempts: 0, executor: "", model: "" },
  PR: { state: "planned", attempts: 0, executor: "", model: "" },
};

function createFixture(t: { after: (callback: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "planner-legacy-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent-graph-001-s9.json");
  writeFileSync(path, JSON.stringify(fixtureState));
  return path;
}

test("旧版 fixture の形", (t) => {
  const state = loadLegacyState(createFixture(t));
  assert.equal(state.tasks.I3.attempts, 1);
  assert.equal(state.branch, "agent/agent-graph-001-s9/integration");
});

test("一致、状態、過不足、試行回数、ファイル一覧、JSON 出力", (t) => {
  const fixture = createFixture(t);
  const repo = mkdtempSync(join(tmpdir(), "planner-compare-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "same.txt"), "same\n");
  git("add", "same.txt"); git("commit", "-m", "initial");
  const initial = git("rev-parse", "HEAD");
  const session = "agent-graph-001-s9";
  const graphId = "graph-test";
  const legacyBranch = `agent/${session}/integration`;
  const plannerBranch = `agent-graph/${session}-${graphId}/integration`;
  git("update-ref", `refs/heads/${legacyBranch}`, initial);
  git("update-ref", `refs/heads/${plannerBranch}`, initial);
  const home = join(repo, "state");
  const key = repoKey(git("rev-parse", "--show-toplevel"));
  const store = openStore(stateDbPath(key, { XDG_STATE_HOME: home }));
  t.after(() => store.close());
  store.upsertRepo({ key, rootPath: repo, name: "compare" });
  store.insertSession({ id: session, repoKey: key, name: session, client: "planner", traceId: "a".repeat(32), startedAt: "2026-01-01" });
  const legacy = loadLegacyState(fixture);
  store.insertGraph({ id: graphId, repoKey: key, sessionId: session, goal: "compare", fingerprint: "fixture", createdAt: "2026-01-01" },
    Object.entries(legacy.tasks).map(([id, row]) => ({ graphId, id, title: id, role: "implement", dependsOn: [], state: row.state as "planned" | "running", attempts: row.attempts })));
  const planner = loadPlannerState(store, { graphId });
  assert.equal(compareRuns(legacy, planner, { repo }).equal, true);
  assert.equal(loadPlannerState(store, { session }).branch, plannerBranch);
  store.db.prepare("INSERT INTO delegations (id, repo_key, session_id, task_id, role, title, status) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("delegation-1", key, session, "I3", "implement", "I3", "done");
  store.db.prepare("INSERT INTO assignments (delegation_id, executor, model, family, tier, reason, policy_version) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("delegation-1", "claude", "sonnet", "anthropic", "mid", "[]", "test");
  const assigned = loadPlannerState(store, { graphId });
  assert.deepEqual([assigned.tasks.I3.executor, assigned.tasks.I3.model], ["claude", "sonnet"]);
  assert.equal(compareRuns(legacy, assigned, { repo }).equal, true);
  store.updateTask(graphId, "I3", "done", 2);
  let result = compareRuns(legacy, loadPlannerState(store, { graphId }), { repo });
  assert.deepEqual(result.differences.filter((row) => row.id === "I3").map((row) => row.kind), ["state", "attempts"]);
  const extra = structuredClone(legacy);
  delete extra.tasks.I2;
  extra.tasks.MISSING = { state: "done", attempts: 1, executor: "", model: "" };
  result = compareRuns(extra, planner, { repo });
  assert.deepEqual(result.differences.filter((row) => row.kind === "task").map((row) => row.id), ["I2", "MISSING"]);
  writeFileSync(join(repo, "new.txt"), "new\n"); git("add", "new.txt"); git("commit", "-m", "new");
  git("update-ref", `refs/heads/${plannerBranch}`, git("rev-parse", "HEAD"));
  result = compareRuns(legacy, loadPlannerState(store, { graphId }), { repo });
  assert.ok(result.differences.some((row) => row.kind === "file" && row.id === "new.txt"));
  const output = spawnSync(process.execPath, [cli, "compare", "--legacy-state", fixture, "--graph", graphId, "--json"],
    { cwd: repo, env: { ...process.env, XDG_STATE_HOME: home }, encoding: "utf8" });
  assert.equal(output.status, 1, output.stderr);
  assert.ok(output.stdout, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout).differences, result.differences);
});
