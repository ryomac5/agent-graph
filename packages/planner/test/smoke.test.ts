import assert from "node:assert/strict";
import test from "node:test";
import * as planner from "../src/index.ts";

test("planner を読み込める", () => {
  for (const name of ["runGraph", "requestDecision", "openPlanner", "worktreeSession", "loadSpec", "validateSpec", "graphFingerprint", "roleForExecutor"] as const) {
    assert.equal(typeof planner[name], "function", name);
  }
});
