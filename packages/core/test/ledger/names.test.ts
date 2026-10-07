import assert from "node:assert/strict";
import test from "node:test";
import type { Fact, FactInput, Source } from "../../src/ledger/facts.ts";
import { projectConversations } from "../../src/ledger/projections/conversations.ts";
import { allocateTaskNames, projectNames, searchNames } from "../../src/ledger/projections/names.ts";

const TS = "2026-01-01T00:00:00.000Z";
function createFact(input: FactInput): Fact {
  return { ...input, fact_id: `${input.source}:${input.source_event_id}`, seq: 1,
    observed_ts: TS, payload_hash: "hash", schema_version: 1, cursor: null,
    supersedes: input.supersedes ?? null } as Fact;
}
function createTask(id: string, project = "agent-graph", name?: string, source: Source = "ui"): Fact {
  return createFact({ source, source_event_id: id, kind: "task.created", subject: `task:${id}`,
    payload: { purpose: "目的", project, state: "open", ...(name ? { name } : {}) }, source_ts: TS, confidence: "confirmed" });
}
function createAlias(id: string, entityId: string, name: string, kind: "kit" | "legacy"): Fact {
  return createFact({ source: kind, source_event_id: id, kind: "alias.created", subject: `alias:${id}`,
    payload: { entity_id: entityId, name, kind }, source_ts: TS, confidence: "confirmed" });
}
test("同時刻の作業も採番が重ならず、到着順と再送によらない", () => {
  const facts = Array.from({ length: 40 }, (_, index) => createTask(`task-${index}`));
  const allocations = allocateTaskNames(facts);
  assert.equal(new Set(allocations.map((allocation) => allocation.name)).size, 40);
  assert.ok(allocations.every((allocation) => /^agent-graph-\d+$/.test(allocation.name)));
  assert.deepEqual(allocateTaskNames([...facts].reverse()), allocations);
  assert.deepEqual(allocateTaskNames([...facts, ...facts]), allocations);
});
test("保存済みの番号を予約し、プロジェクトごとに次の番号を割り当てる", () => {
  const facts = [createTask("existing", "agent-graph", "agent-graph-17"), createTask("new"), createTask("other", "other-project")];
  assert.deepEqual(allocateTaskNames(facts), [{ task_id: "new", name: "agent-graph-18" }, { task_id: "other", name: "other-project-1" }]);
  const names = projectNames(facts);
  assert.equal(names.tasks.find((task) => task.id === "existing")?.name, "agent-graph-17");
});
test("割り当てを作成の事実に保存すれば、後続の作業でも番号を再利用しない", () => {
  const candidates = [createTask("a"), createTask("b")];
  const allocations = allocateTaskNames(candidates);
  const persisted = candidates.map((fact) => ({ ...fact, payload: { ...fact.payload,
    name: allocations.find((allocation) => allocation.task_id === fact.subject.slice(5))!.name } } as Fact));
  assert.deepEqual(allocateTaskNames([...persisted, createTask("c")]), [{ task_id: "c", name: "agent-graph-3" }]);
  assert.equal(allocateTaskNames(persisted).length, 0);
});
test("unattended の会話は確定した名前を持たず、その作業も採番しない", () => {
  const facts = [createTask("task", "agent-graph", undefined, "intake"), createFact({ source: "host-codex", source_event_id: "exec", kind: "conversation.created", subject: "conversation:exec",
    payload: { provider: "codex", native_id: "exec", origin: "managed", type: "unattended", history_format: "paginated", task_id: "task" },
    source_ts: TS, confidence: "confirmed" })];
  const projection = projectConversations(facts);
  assert.equal(projection.conversations.length, 1);
  assert.equal(projection.conversations[0].name, null);
  assert.equal(projection.tasks[0].name, undefined);
  assert.deepEqual(allocateTaskNames(facts), []);
  assert.equal(projectConversations([createTask("task", "agent-graph", "agent-graph-1"), facts[1]]).conversations[0].name, null);
});
test("会話がまだない委譲作業は番号を取らず、利用者起点の作業だけを採番する", () => {
  const delegated = createTask("delegated", "agent-graph", undefined, "intake");
  const userTask = createTask("user");
  const expected = [{ task_id: "user", name: "agent-graph-1" }];
  assert.deepEqual(allocateTaskNames([delegated]), []);
  assert.deepEqual(allocateTaskNames([delegated, userTask]), expected);
  for (const type of ["unattended", "subagent", "interactive"] as const) {
    const conversation = createFact({ source: "host-codex", source_event_id: type,
      kind: "conversation.created", subject: `conversation:${type}`,
      payload: { provider: "codex", native_id: type, origin: "managed", type,
        history_format: "paginated", task_id: "delegated" },
      source_ts: "2026-01-02T00:00:00.000Z", confidence: "confirmed" });
    const facts = [delegated, userTask, conversation];
    assert.deepEqual(allocateTaskNames(facts), expected);
    assert.deepEqual(allocateTaskNames([...facts].reverse()), expected);
  }
});
test("利用者起点であると確認できない作成の出所では採番しない", () => {
  const sources: Source[] = ["host-claude", "host-codex", "hook", "transcript-claude", "rollout-codex", "kit", "legacy"];
  assert.deepEqual(allocateTaskNames(sources.map((source) => createTask(source, "agent-graph", undefined, source))), []);
});
test("kit の枝番号と legacy の ULID を名前とは別に検索する", () => {
  const facts = [createTask("a", "agent-graph", "agent-graph-1"), createTask("b", "agent-graph", "agent-graph-2"),
    createAlias("branch-b", "a", "agent-graph-017b", "kit"), createAlias("branch-s3", "a", "agent-graph-001-s3", "kit"),
    createAlias("collision", "b", "agent-graph-1", "kit"), createAlias("ulid", "a", "01M494FPM1659G6QPCAJFN1MXE", "legacy")];
  const projection = projectNames(facts);
  assert.deepEqual(searchNames(projection, "agent-graph-1"), ["a"]);
  assert.deepEqual(searchNames(projection, "agent-graph-1", "kit"), ["b"]);
  assert.deepEqual(searchNames(projection, "agent-graph-017b", "kit"), ["a"]);
  assert.deepEqual(searchNames(projection, "agent-graph-001-s3", "kit"), ["a"]);
  assert.deepEqual(searchNames(projection, "01M494FPM1659G6QPCAJFN1MXE", "legacy"), ["a"]);
  assert.equal(projection.tasks.length, 2);
  assert.deepEqual(projectNames([...facts].reverse()), projection);
});
test("重複する保存済みの名前を黙って上書きしない", () => {
  assert.throws(() => allocateTaskNames([createTask("a", "project", "project-1"), createTask("b", "project", "project-1")]), /重複/);
});

test("別プロジェクトの不規則な名前も予約して採番の衝突を避ける", () => {
  const facts = [createTask("existing", "other-project", "agent-graph-1"), createTask("a"), createTask("b")];
  const expected = [{ task_id: "a", name: "agent-graph-2" }, { task_id: "b", name: "agent-graph-3" }];
  assert.deepEqual(allocateTaskNames(facts), expected);
  assert.deepEqual(allocateTaskNames([...facts].reverse()), expected);
});

test("ui 作成でも無人会話だけに紐づく作業は採番しない", () => {
  const task = createTask("task");
  const unattended = createFact({ source: "host-codex", source_event_id: "exec-ui-task",
    kind: "conversation.created", subject: "conversation:exec",
    payload: { provider: "codex", native_id: "exec", origin: "managed", type: "unattended",
      history_format: "paginated", task_id: "task" }, source_ts: TS, confidence: "confirmed" });
  assert.deepEqual(allocateTaskNames([task, unattended]), []);
  assert.deepEqual(allocateTaskNames([unattended, task]), []);
  const interactive = createFact({ source: "host-codex", source_event_id: "interactive-ui-task",
    kind: "conversation.created", subject: "conversation:interactive",
    payload: { provider: "codex", native_id: "interactive", origin: "managed", type: "interactive",
      history_format: "paginated", task_id: "task" }, source_ts: TS, confidence: "confirmed" });
  const facts = [task, unattended, interactive];
  assert.deepEqual(allocateTaskNames(facts), [{ task_id: "task", name: "agent-graph-1" }]);
  assert.deepEqual(allocateTaskNames([...facts].reverse()), allocateTaskNames(facts));
});
