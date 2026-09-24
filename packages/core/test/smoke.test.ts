import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/index.ts";

test("core を読み込める", () => {
  assert.deepEqual(Object.keys(core), []);
});
