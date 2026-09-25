import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../src/index.ts";

test("core からトレース文脈と ULID の公開関数を読み込める", () => {
  const functions = [
    "childContext",
    "formatTraceparent",
    "formatTracestate",
    "fromEnv",
    "newSpanId",
    "newTraceId",
    "parseTraceparent",
    "parseTracestate",
    "toEnv",
    "ulid",
    "runDelegation",
    "assign",
    "defaultPolicyTable",
    "runAcceptance",
    "execute",
  ] as const;
  for (const name of functions) {
    assert.equal(typeof core[name], "function", name);
  }
});
