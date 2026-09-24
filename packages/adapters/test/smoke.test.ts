import assert from "node:assert/strict";
import test from "node:test";
import * as adapters from "../src/index.ts";

test("adapters を読み込める", () => {
  assert.deepEqual(Object.keys(adapters), []);
});
