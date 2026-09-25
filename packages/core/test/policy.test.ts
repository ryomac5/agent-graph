import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPolicy, parsePolicyToml } from "../src/assign/policy.ts";

test("TOML の数値と役割候補を読む", () => {
  const parsed = parsePolicyToml(`
[quota]
softLimitPercent = 60
hardLimitPercent = 80
[performance]
minSamples = 10
[performance.weights]
acceptRate = 0.5
[[roles.review]]
executor = "codex"
model = "custom"
family = "openai"
tier = "high"
`);
  assert.equal(parsed.quota?.hardLimitPercent, 80);
  assert.equal(parsed.performance?.weights.acceptRate, 0.5);
  assert.equal(parsed.roles?.review[0].model, "custom");
});

test("対応外構文は行番号を返す", () => {
  assert.throws(() => parsePolicyToml("[quota]\nunknown = 3"), /line 2/);
});

test("XDG_CONFIG_HOME を優先し、JSON が TOML より優先する", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-graph-policy-"));
  const xdg = join(root, "xdg");
  mkdirSync(join(xdg, "agent-graph"), { recursive: true });
  writeFileSync(join(xdg, "agent-graph", "policy.toml"), "[quota]\nsoftLimitPercent = 60\n");
  const jsonPath = join(root, "policy.json");
  writeFileSync(jsonPath, JSON.stringify({ quota: { softLimitPercent: 55 } }));
  assert.equal(loadPolicy({ home: root, env: { XDG_CONFIG_HOME: xdg } }).quota.softLimitPercent, 60);
  assert.equal(loadPolicy({ home: root, env: { XDG_CONFIG_HOME: xdg, AGENT_GRAPH_POLICY_JSON: jsonPath } }).quota.softLimitPercent, 55);
});

test("JSON の不正な constraints を拒否する", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-graph-policy-"));
  const jsonPath = join(root, "policy.json");
  for (const constraints of [
    {},
    [{ kind: "unknown" }],
    [{ kind: "minTierForRole", role: "implement", tier: "hgh" }],
    [{ kind: "minTierForRole", role: "unknown", tier: "high" }],
  ]) {
    writeFileSync(jsonPath, JSON.stringify({ constraints }));
    assert.throws(() => loadPolicy({ home: root, env: { AGENT_GRAPH_POLICY_JSON: jsonPath } }), TypeError);
  }
});

test("TOML の不正な constraints を拒否する", () => {
  for (const constraint of [
    'kind = "unknown"',
    'kind = "minTierForRole"\nrole = "implement"\ntier = "hgh"',
    'kind = "minTierForRole"\nrole = "unknown"\ntier = "high"',
  ]) {
    assert.throws(() => parsePolicyToml(`[[constraints]]\n${constraint}\n`), TypeError);
  }
  const root = mkdtempSync(join(tmpdir(), "agent-graph-policy-"));
  const path = join(root, "policy.toml");
  writeFileSync(path, '[[constraints]]\nkind = "minTierForRole"\nrole = "implement"\ntier = "hgh"\n');
  assert.throws(() => loadPolicy({ path, env: {}, home: root }), TypeError);
});

test("レビュー往復の既定値と TOML 上書きを読む", () => {
  assert.equal(loadPolicy({ path: "/nonexistent/policy.toml", env: {} }).maxRoundTrips, 2);
  assert.equal(parsePolicyToml("[review]\nmax_round_trips = 3\n").maxRoundTrips, 3);
  assert.throws(() => parsePolicyToml("[review]\nmax_round_trips = -1\n"), /line 2/);
});
