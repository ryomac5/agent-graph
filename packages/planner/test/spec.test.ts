import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { graphFingerprint, loadSpec, roleForExecutor, validateSpec, type GraphSpec, type TaskSpec } from "../src/spec.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
for (const file of readdirSync(fixtures)) test(`validate ${file}`, () => {
  assert.deepEqual(validateSpec(loadSpec(new URL(file, fixtures).pathname)), []);
});
const task = (id: string, executor = "codex"): TaskSpec => ({
  id, title: id, executor, depends_on: [], scope: ["src/**"], inputs: [], outputs: [],
  accept: ["true"], prompt: "work", review: executor === "codex", model: "", model_reason: "",
  review_model: "", retry: { max: 1, escalate_to: "human" }, timeout_sec: 1800,
});
const spec = (...tasks: TaskSpec[]): GraphSpec => ({ goal: "goal", base_branch: "main", tasks });
const invalid = (tasks: TaskSpec[], fragment: string): void => {
  assert.ok(validateSpec(spec(...tasks)).some((error) => error.includes(fragment)), fragment);
};
test("validation rules", () => {
  invalid([], "tasks が空");
  invalid([task("bad id")], "id は英数字");
  invalid([task("x"), task("x")], "id が重複");
  invalid([task("x", "unknown")], "executor");
  invalid([{ ...task("x"), title: "" }], "title が必要");
  invalid([{ ...task("x"), depends_on: ["missing"] }], "存在しない");
  invalid([{ ...task("x"), depends_on: ["x"] }], "自分自身");
  invalid([{ ...task("x"), depends_on: ["y"] }, { ...task("y"), depends_on: ["x"] }], "循環");
  for (const executor of ["codex", "doc-light", "doc-heavy"]) {
    invalid([{ ...task("x", executor), accept: [] }], "accept");
    invalid([{ ...task("x", executor), prompt: " " }], "prompt が空");
  }
  invalid([{ ...task("x"), scope: [] }], "scope");
  invalid([{ ...task("x"), retry: { max: 1, escalate_to: "unknown" } }], "retry.escalate_to");
  invalid([task("a", "pr"), task("b", "pr")], "1 つまで");
  invalid([task("a"), task("p", "pr")], "最終ノード");
  invalid([task("a"), { ...task("p", "pr"), depends_on: ["a"] }], "human の承認ゲート");
});
test("normalization and fingerprint", () => {
  const loaded = loadSpec(new URL("agent-graph-001-s6.yaml", fixtures).pathname);
  assert.equal(loaded.tasks[0]?.retry.escalate_to, "human");
  assert.equal(loaded.tasks[0]?.timeout_sec, 1800);
  assert.equal(roleForExecutor("doc-heavy"), "document");
  assert.equal(roleForExecutor("human"), "human");
  const expected = createHash("sha256").update("goal\na:implement\nb:document").digest("hex").slice(0, 16);
  assert.equal(graphFingerprint(spec(task("b", "doc-light"), task("a"))), expected);
});
