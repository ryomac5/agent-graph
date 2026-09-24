import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assign, defaultPolicyTable } from "../src/assign/static.ts";
import type { DelegateRequest, Role } from "../src/delegate/types.ts";

function request(role: Role, constraints?: DelegateRequest["constraints"]): DelegateRequest {
  return { role, title: "task", task: "task", accept: ["true"], constraints };
}

test("役割ごとの先頭候補を選ぶ", () => {
  const expected = { implement: "gpt-6-astra", review: "fable", research: "sonnet", document: "sonnet", orchestrate: "fable" };
  for (const [role, model] of Object.entries(expected)) {
    const result = assign(request(role as Role), defaultPolicyTable());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.assignment.model, model);
      assert.equal(result.assignment.policyVersion, "static-1");
      assert.ok(result.assignment.reason.length >= 2);
    }
  }
});

test("系統除外と最低 tier を適用する", () => {
  const table = defaultPolicyTable();
  const family = assign(request("implement", { excludeFamily: ["openai"] }), table);
  assert.equal(family.ok, true);
  if (family.ok) assert.equal(family.assignment.model, "opus");
  const tier = assign(request("document", { minTier: "high" }), table);
  assert.equal(tier.ok, true);
  if (tier.ok) assert.equal(tier.assignment.model, "opus");
});

test("候補が尽きると理由を返す", () => {
  const result = assign(request("review", { excludeFamily: ["anthropic", "openai"] }), defaultPolicyTable());
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason.join(" "), /no candidates remain/);
});

test("環境変数の JSON で表を置き換える", () => {
  const path = join(mkdtempSync(join(tmpdir(), "agent-graph-policy-")), "policy.json");
  const roles = defaultPolicyTable();
  roles.implement = [{ executor: "claude", model: "custom", family: "anthropic", tier: "low" }];
  writeFileSync(path, JSON.stringify({ roles }));
  const previous = process.env.AGENT_GRAPH_POLICY_JSON;
  try {
    process.env.AGENT_GRAPH_POLICY_JSON = path;
    assert.equal(defaultPolicyTable().implement[0].model, "custom");
    writeFileSync(path, "invalid");
    assert.throws(() => defaultPolicyTable());
  } finally {
    if (previous === undefined) delete process.env.AGENT_GRAPH_POLICY_JSON;
    else process.env.AGENT_GRAPH_POLICY_JSON = previous;
  }
});
