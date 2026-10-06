import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createRepositoryId, openLedger, project, projectProjects, projectUnsupportedObservations,
} from "../../src/ledger/index.ts";
import type { Fact, FactInput, Ledger, ProjectPayload, UnsupportedObservationPayload } from "../../src/ledger/index.ts";

const TS = "2026-01-01T00:00:00.000Z";
const LATER_TS = "2026-01-02T00:00:00.000Z";
const LATEST_TS = "2026-01-03T00:00:00.000Z";
const REPOSITORY_ID = createRepositoryId("/repositories/example/.git");
const PROJECT: ProjectPayload = {
  repository_id: REPOSITORY_ID, root_path: "/repositories/example",
  display_name: "Example", name_prefix: "example", state: "registered",
};

function openFixture(t: TestContext): Ledger {
  const ledger = openLedger(":memory:");
  t.after(() => ledger.close());
  return ledger;
}

function createProjectInput(id = "register", payload = PROJECT): Extract<FactInput, { kind: "project.created" }> {
  return {
    source: "ui", source_event_id: id, kind: "project.created", subject: `project:${payload.repository_id}`,
    payload, source_ts: TS, observed_ts: TS, confidence: "confirmed",
  };
}

function createUnsupportedInput(
  id: string, payload: Partial<UnsupportedObservationPayload> = {}, observedTs = TS,
): Extract<FactInput, { kind: "observation.unsupported" }> {
  return {
    source: "rollout-codex", source_event_id: id, kind: "observation.unsupported", subject: `observation:${id}`,
    payload: {
      source_kind: "rollout-codex", file_path: `/sessions/${id}.jsonl`,
      format_name: "future", format_version: "2", reason: "未対応の形式", ...payload,
    }, source_ts: TS, observed_ts: observedTs, confidence: "confirmed",
  };
}

function assertOrderIndependent(t: TestContext, inputs: FactInput[], expected: ReturnType<typeof project>): void {
  for (let index = 0; index < inputs.length; index += 1) {
    const ledger = openFixture(t);
    const reordered = [...inputs.slice(index), ...inputs.slice(0, index)].reverse();
    for (const input of reordered) {
      assert.equal(ledger.append(input).status, "appended");
      assert.equal(ledger.append(input).status, "duplicate");
    }
    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    assert.equal(facts.length, inputs.length);
    assert.deepEqual(project(facts), expected);
    assert.deepEqual(project([...facts, ...facts].reverse()), expected);
  }
}

test("プロジェクトの登録、解除、再登録は追記で表し、履歴と前置きを残す", (t) => {
  const ledger = openFixture(t);
  const registered = createProjectInput();
  const unregistered: FactInput = {
    ...registered, kind: "project.state_changed", source_event_id: "unregister",
    payload: { state: "unregistered" }, source_ts: LATER_TS,
  };
  const reregistered: FactInput = {
    ...registered, kind: "project.state_changed", source_event_id: "reregister",
    payload: { state: "registered" }, source_ts: LATEST_TS,
  };
  ledger.append(registered);
  assert.deepEqual(projectProjects(ledger.readSince(0, 10)), [{ ...PROJECT, id: REPOSITORY_ID }]);
  ledger.append(unregistered);
  assert.deepEqual(projectProjects(ledger.readSince(0, 10)), [{ ...PROJECT, id: REPOSITORY_ID, state: "unregistered" }]);
  ledger.append(reregistered);
  const facts = ledger.readSince(0, 10);
  assert.equal(facts.length, 3);
  assert.deepEqual(facts[0].payload, PROJECT);
  assert.deepEqual(projectProjects(facts), [{ ...PROJECT, id: REPOSITORY_ID }]);
  assertOrderIndependent(t, [registered, unregistered, reregistered], project(facts));
});

test("同じ git 共通ディレクトリの実パスなら別の作業ツリーも同じプロジェクトになる", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-graph-projects-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repository");
  const worktree = join(dir, "worktree");
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  execFileSync("git", ["-C", root, "worktree", "add", "--quiet", "--detach", worktree]);
  const linked = join(dir, "linked-repository");
  symlinkSync(root, linked);
  const ids = [root, worktree, linked].map((cwd) => {
    const commonDirectory = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" }).trim();
    return createRepositoryId(realpathSync(commonDirectory));
  });
  assert.equal(new Set(ids).size, 1);
  assert.notEqual(ids[0], createRepositoryId(join(dir, "another-repository", ".git")));
  const inputs = [root, worktree].map((root_path, index) => ({
    ...createProjectInput(`register-${index}`, { ...PROJECT, repository_id: ids[index], root_path }),
    source_ts: index === 0 ? TS : LATER_TS,
  }));
  const ledger = openFixture(t);
  for (const input of inputs) ledger.append(input);
  const projection = project(ledger.readSince(0, 10));
  assert.deepEqual(projection.projects, [{ ...PROJECT, repository_id: ids[0], id: ids[0], root_path: worktree }]);
  assertOrderIndependent(t, inputs, projection);
});

test("前置きの変更と訂正をプロジェクトに保持し、既存の名前と投影は変えない", (t) => {
  const ledger = openFixture(t);
  const task: FactInput = {
    source: "ui", source_event_id: "task", kind: "task.created", subject: "task:existing",
    payload: { project: REPOSITORY_ID, name: "example-1", purpose: "作業", state: "open" },
    source_ts: TS, observed_ts: TS, confidence: "confirmed",
  };
  ledger.append(task);
  const original = project(ledger.readSince(0, 10));
  const registered = createProjectInput();
  ledger.append(registered);
  const changed: FactInput = {
    ...registered, kind: "project.updated", source_event_id: "prefix",
    payload: { name_prefix: "new" }, source_ts: LATER_TS,
  };
  const updated = ledger.append(changed);
  const corrected: FactInput = {
    ...registered, kind: "project.corrected", source_event_id: "correct-prefix", supersedes: updated.fact_id,
    payload: { name_prefix: "correct" }, source_ts: LATEST_TS,
  };
  ledger.append(corrected);
  const facts = ledger.readSince(0, 10);
  const projection = project(facts);
  assert.deepEqual(projection.projects, [{ ...PROJECT, name_prefix: "correct", id: REPOSITORY_ID }]);
  assert.deepEqual({ ...projection, projects: [], unsupported_observations: [] }, original);
  const prefixFact = facts[2];
  assert.ok(prefixFact.kind === "project.updated");
  assert.equal(prefixFact.payload?.name_prefix, "new");
  assertOrderIndependent(t, [task, registered, changed, corrected], projection);
});

test("未対応の件数と最後の検出時刻を出所、形式、版ごとに返し、再送を数えない", (t) => {
  const ledger = openFixture(t);
  const inputs = [
    createUnsupportedInput("first"),
    createUnsupportedInput("last", {}, LATEST_TS),
    createUnsupportedInput("other-source", { source_kind: "transcript-claude" }, LATER_TS),
    createUnsupportedInput("other-format", { format_name: "other" }),
    createUnsupportedInput("other-version", { format_version: "3" }),
  ];
  for (const input of inputs) ledger.append(input);
  const facts = ledger.readSince(0, 10);
  assert.deepEqual(projectUnsupportedObservations(facts), [
    { source_kind: "rollout-codex", format_name: "future", format_version: "2", count: 2, last_detected_ts: LATEST_TS },
    { source_kind: "rollout-codex", format_name: "future", format_version: "3", count: 1, last_detected_ts: TS },
    { source_kind: "rollout-codex", format_name: "other", format_version: "2", count: 1, last_detected_ts: TS },
    { source_kind: "transcript-claude", format_name: "future", format_version: "2", count: 1, last_detected_ts: LATER_TS },
  ]);
  for (const fact of facts) {
    assert.ok(fact.kind === "observation.unsupported");
    assert.deepEqual(Object.keys(fact.payload!).sort(), ["file_path", "format_name", "format_version", "reason", "source_kind"]);
  }
  assertOrderIndependent(t, inputs, project(facts));
});

test("保持整理後の未対応 payload は集計せず、同時刻の表記差でも順序に依存しない", (t) => {
  const ledger = openFixture(t);
  ledger.append(createUnsupportedInput("utc", {}, TS));
  ledger.append(createUnsupportedInput("offset", {}, "2026-01-01T09:00:00.000+09:00"));
  const facts = ledger.readSince(0, 10);
  const snapshot = structuredClone(facts);
  assert.deepEqual(projectUnsupportedObservations(facts), projectUnsupportedObservations([...facts].reverse()));
  assert.equal(projectUnsupportedObservations(facts)[0].count, 2);
  assert.deepEqual(facts, snapshot);
  const purged = facts.map((fact) => ({ ...fact, payload: null }) as Fact);
  assert.deepEqual(projectUnsupportedObservations(purged), []);
});
