import assert from "node:assert/strict";
import test from "node:test";
import * as dashboard from "../src/index.ts";

test("dashboard を読み込める", () => {
  assert.deepEqual(Object.keys(dashboard), []);
});
