import assert from "node:assert/strict";
import test from "node:test";
import * as daemon from "../src/index.ts";

test("daemon を読み込める", () => {
  assert.deepEqual(Object.keys(daemon), []);
});
