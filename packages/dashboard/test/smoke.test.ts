import assert from "node:assert/strict";
import test from "node:test";
import * as dashboard from "../src/index.ts";

test("dashboard の純粋な処理を型付きで読み込める", () => {
  assert.equal(typeof dashboard.layoutGraph, "function");
  assert.equal(typeof dashboard.modelLabel, "function");
  assert.equal(typeof dashboard.visibleView, "function");
  assert.equal(typeof dashboard.usageLevel, "function");
  assert.equal(dashboard.modelLabel("claude-fable-5-1"), "Fable 5.1");
});
