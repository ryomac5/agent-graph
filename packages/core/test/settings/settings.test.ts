import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, defaultBrowser, getDefaults, validateSettings } from "../../src/settings/index.ts";

test("defaults cover all stores and retain policy compatibility", () => {
  for (const store of ["config", "policy", "project", "browser"] as const) assert.deepEqual(validateSettings(store, {}), getDefaults(store));
  assert.equal(defaultConfig().storage.bodyRetentionDays, 90);
  assert.equal(defaultConfig().storage.metadataRetentionDays, null);
  assert.equal(defaultBrowser().theme, "system"); assert.equal(defaultBrowser().language, "en");
  assert.deepEqual(Object.keys(defaultBrowser().notifications).sort(), ["approval", "input", "completed", "failed", "reviewInvalidated", "unknown", "runnerFailure", "apiFailure", "disconnected"].sort());
});
test("rejects invalid settings without mutating defaults", () => {
  for (const patch of [{ dashboard: { port: 0 } }, { dashboard: { port: 7420 } }, { storage: { redaction: { patterns: ["["] } } }, { keys: { allow: "d" } }, { agents: { claude: { authentication: "bad" } } }, { notifications: { quietStart: "99:00" } }, { isolation: { policy: "bad" } }, { storage: { bodyRetentionDays: -1 } }]) assert.throws(() => validateSettings("config", patch));
  assert.throws(() => validateSettings("policy", { quota: { softLimitPercent: 95, hardLimitPercent: 90 } }));
  for (const roles of [[], "", 1, null]) assert.throws(() => validateSettings("policy", { roles }), /Invalid roles/);
  assert.throws(() => validateSettings("policy", { roles: { implement: [{ executor: "bad", model: "m", tier: "high", family: "openai" }] } }));
  assert.throws(() => validateSettings("browser", { language: "bad" }));
  assert.equal(defaultConfig().keys.allow, "a");
});
