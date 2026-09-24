import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { repoKey, stateDbPath, fingerprint } from "../src/index.ts";

test("repoKey は絶対パスの sha256 を使い、同名の別パスを区別する", () => {
  const root = "/work/a/project";
  const expected = createHash("sha256").update(root).digest("hex").slice(0, 8);
  assert.equal(repoKey(root), `project-${expected}`);
  assert.notEqual(repoKey(root), repoKey("/work/b/project"));
  assert.throws(() => repoKey("relative/project"), TypeError);
});

test("stateDbPath は注入した home を使い XDG_STATE_HOME を優先する", () => {
  const key = repoKey("/work/project");
  assert.equal(stateDbPath(key, {}, "/home/test"),
    `/home/test/.local/state/agent-graph/${key}/agent-graph.db`);
  assert.equal(stateDbPath(key, { XDG_STATE_HOME: "/state" }, "/home/test"),
    `/state/agent-graph/${key}/agent-graph.db`);
  assert.equal(stateDbPath(key, { XDG_STATE_HOME: "" }, "/home/test"),
    stateDbPath(key, {}, "/home/test"));
  assert.throws(() => stateDbPath("../repo", {}, "/home/test"), TypeError);
  assert.throws(() => stateDbPath(key, { XDG_STATE_HOME: "relative" }), TypeError);
});

test("指紋は goal の前後空白とタスク順序を無視し、id と role の変更を区別する", () => {
  const tasks = [{ id: "b", role: "review" }, { id: "a", role: "implement" }] as const;
  const graph = { goal: " goal ", tasks: [...tasks] };
  const expected = createHash("sha256").update("goal\na:implement\nb:review").digest("hex").slice(0, 16);
  assert.equal(fingerprint(graph), expected);
  assert.equal(fingerprint({ goal: "goal", tasks: [...tasks].reverse() }), expected);
  assert.notEqual(fingerprint({ ...graph, goal: "other" }), expected);
  assert.notEqual(fingerprint({ ...graph, tasks: [{ id: "a", role: "review" }] }), expected);
  assert.notEqual(fingerprint({ ...graph, tasks: [{ id: "c", role: "implement" }, tasks[0]] }), expected);
  assert.deepEqual(graph.tasks, tasks);
});
