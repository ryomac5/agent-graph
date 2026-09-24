import assert from "node:assert/strict";
import test from "node:test";
import * as planner from "../src/index.ts";

test("planner を読み込める", () => {
  assert.deepEqual(Object.keys(planner), []);
});
