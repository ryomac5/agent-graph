import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assign, defaultPolicyTable } from "../src/assign/static.ts";
import { decide } from "../src/assign/assign.ts";
import { defaultPolicy } from "../src/assign/policy.ts";
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
      assert.match(result.assignment.policyVersion, /^policy-[0-9a-f]{8}$/);
      assert.ok(result.assignment.reason.length >= 2);
    }
  }
});

test("hard 超で除外し、soft 超で降格する。各段の理由を残す", () => {
  const policy = defaultPolicy();
  const input = {
    policy,
    quota: (candidate: { model: string }) => candidate.model === "gpt-6-astra"
      ? { percent: 90, source: "weekly" } : candidate.model === "gpt-6-sol"
        ? { percent: 70, source: "primary" } : undefined,
    performance: () => undefined,
  };
  const result = decide(request("implement"), input);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.assignment.model, "opus");
    const reasons = result.assignment.reason.join(" ");
    for (const stage of ["stage 1", "stage 2", "stage 3", "stage 4"]) assert.match(reasons, new RegExp(stage));
    assert.match(reasons, /90% \(weekly\).*70% \(primary\)/);
  }
});

test("hard で全候補が外れる", () => {
  const result = decide(request("review"), {
    policy: defaultPolicy(), quota: () => ({ percent: 95, source: "limit" }), performance: () => undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason.join(" "), /hard.*stage 4.*no candidates remain/);
});

test("実績不足は静的順位、十分ならスコア順", () => {
  const policy = defaultPolicy();
  const performance = (_role: Role, model: string) => ({
    samples: 19, acceptRate: model === "gpt-6-sol" ? 1 : 0,
    reviewApprove: 0, avgRoundTrips: 0, avgTokens: 0,
  });
  const input = { policy, quota: () => undefined, performance };
  const first = decide(request("implement"), input);
  assert.equal(first.ok && first.assignment.model, "gpt-6-astra");
  const second = decide(request("implement"), {
    ...input, performance: (role: Role, model: string) => ({ ...performance(role, model), samples: 20 }),
  });
  assert.equal(second.ok && second.assignment.model, "gpt-6-sol");
});

test("policy 制約と依頼の minTier を適用する", () => {
  const input = { policy: defaultPolicy(), quota: () => undefined, performance: () => undefined };
  const reviewer = decide(request("review"), { ...input, implementerFamily: "anthropic" as const });
  assert.equal(reviewer.ok && reviewer.assignment.family, "openai");
  const implementer = decide(request("implement"), { ...input, orchestratorModel: "gpt-6-astra" });
  assert.equal(implementer.ok && implementer.assignment.model, "gpt-6-sol");
  const policy = defaultPolicy();
  policy.constraints.push({ kind: "minTierForRole", role: "document", tier: "high" });
  const tier = decide(request("document", { minTier: "high" }), { ...input, policy });
  assert.equal(tier.ok && tier.assignment.model, "opus");
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
