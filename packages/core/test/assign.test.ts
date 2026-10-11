import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assign, defaultPolicyTable } from "../src/assign/static.ts";
import { decide } from "../src/assign/assign.ts";
import { defaultPolicy, getCandidates, policyVersion } from "../src/assign/policy.ts";
import type { DelegateRequest, Role } from "../src/delegate/types.ts";

function createPolicy() {
  const policy = defaultPolicy();
  policy.roles.implement = [...getCandidates(policy, "implement").slice(0, 1), { executor: "codex", model: "gpt-6.1-sol", family: "openai", tier: "mid" }, ...getCandidates(policy, "implement").slice(1)];
  policy.roles.document = [{ executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" }, { executor: "claude", model: "opus", family: "anthropic", tier: "high" }];
  return policy;
}
function request(role: Role, constraints?: DelegateRequest["constraints"]): DelegateRequest {
  return { role, title: "task", task: "task", accept: ["true"], constraints };
}

test("役割ごとの先頭候補を選ぶ", () => {
  const expected = { implement: "gpt-6-astra", review: "opus", research: "sonnet", document: "opus", orchestrate: "opus" };
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
  const policy = createPolicy();
  const input = {
    policy,
    quota: (candidate: { model: string }) => candidate.model === "gpt-6-astra"
      ? { percent: 90, source: "weekly" } : candidate.model === "gpt-6.1-sol"
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
  const policy = createPolicy();
  const performance = (_role: Role, model: string) => ({
    samples: 19, acceptRate: model === "gpt-6.1-sol" ? 1 : 0,
    reviewApprove: 0, avgRoundTrips: 0, avgTokens: 0,
  });
  const input = { policy, quota: () => undefined, performance };
  const first = decide(request("implement"), input);
  assert.equal(first.ok && first.assignment.model, "gpt-6-astra");
  const second = decide(request("implement"), {
    ...input, performance: (role: Role, model: string) => ({ ...performance(role, model), samples: 20 }),
  });
  assert.equal(second.ok && second.assignment.model, "gpt-6.1-sol");
});

test("数万トークンでも重み 0.1 が順位を支配せず、各候補の項別点を残す", () => {
  const policy = defaultPolicy();
  const input = { policy, quota: () => undefined, performance: (_role: Role, model: string) => ({
    samples: 20, acceptRate: model === "opus" ? 0.9 : 0.6, reviewApprove: model === "opus" ? 0.9 : 0.6,
    avgRoundTrips: model === "opus" ? 2 : 1, avgTokens: model === "opus" ? 50_000 : 10_000,
  }) };
  const result = decide(request("implement"), input);
  assert.ok(result.ok);
  assert.equal(result.assignment.model, "opus");
  assert.ok(result.assignment.reason.includes("stage 3 score opus: acceptRate=0.400000 reviewApprove=0.300000 roundTrips=0.000000 tokens=0.000000 total=0.700000"));
  assert.ok(result.assignment.reason.includes("stage 3 score gpt-6-astra: acceptRate=0.000000 reviewApprove=0.000000 roundTrips=0.200000 tokens=0.100000 total=0.300000"));
  policy.performance.weights = { acceptRate: 4, reviewApprove: 3, roundTrips: 2, tokens: 1 };
  assert.deepEqual(decide(request("implement"), input), {
    ...result, assignment: { ...result.assignment, policyVersion: policyVersion(policy) },
  });
});

test("合格率の重みを上げると合格率の高い候補が上に来る", () => {
  const policy = defaultPolicy();
  policy.performance.weights = { acceptRate: 1, reviewApprove: 6, roundTrips: 2, tokens: 1 };
  const input = { policy, quota: () => undefined, performance: (_role: Role, model: string) => ({
    samples: 20, acceptRate: model === "opus" ? 0.9 : 0.6, reviewApprove: model === "opus" ? 0.6 : 0.9,
    avgRoundTrips: 2, avgTokens: 30_000,
  }) };
  const before = decide(request("implement"), input);
  assert.ok(before.ok);
  assert.equal(before.assignment.model, "gpt-6-astra");
  policy.performance.weights.acceptRate = 8;
  const after = decide(request("implement"), input);
  assert.ok(after.ok);
  assert.equal(after.assignment.model, "opus");
});

test("候補間の中間値も正規化し、往復とトークンは少ないほど高得点にする", () => {
  const policy = createPolicy();
  const values = {
    "gpt-6-astra": { acceptRate: 0.6, reviewApprove: 0.3, avgRoundTrips: 1, avgTokens: 10_000 },
    "gpt-6.1-sol": { acceptRate: 0.8, reviewApprove: 0.6, avgRoundTrips: 2, avgTokens: 30_000 },
    opus: { acceptRate: 1, reviewApprove: 0.9, avgRoundTrips: 3, avgTokens: 50_000 },
  };
  const result = decide(request("implement"), { policy, quota: () => undefined,
    performance: (_role, model) => ({ samples: 20, ...values[model as keyof typeof values] }),
  });
  assert.ok(result.ok);
  assert.equal(result.assignment.model, "opus");
  assert.ok(result.assignment.reason.includes("stage 3 score gpt-6.1-sol: acceptRate=0.200000 reviewApprove=0.150000 roundTrips=0.100000 tokens=0.050000 total=0.500000"));
});

test("全候補が同じ値の項は 0 点となり、同点と単独候補は元の順を保つ", () => {
  const policy = defaultPolicy();
  const input = { policy, quota: () => undefined, performance: () => ({
    samples: 20, acceptRate: 0.8, reviewApprove: 0.9, avgRoundTrips: 2, avgTokens: 30_000,
  }) };
  for (const role of ["implement", "research"] as const) {
    const result = decide(request(role), input);
    assert.ok(result.ok);
    assert.equal(result.assignment.model, getCandidates(policy, role)[0].model);
    const scores = result.assignment.reason.filter(reason => reason.startsWith("stage 3 score "));
    assert.equal(scores.length, getCandidates(policy, role).length);
    for (const score of scores) assert.match(score, /acceptRate=0\.000000 reviewApprove=0\.000000 roundTrips=0\.000000 tokens=0\.000000 total=0\.000000$/);
  }
});

test("重みの合計が 0 なら実績にかかわらず利用枠適用後の順を保つ", () => {
  const policy = defaultPolicy();
  policy.performance.weights = { acceptRate: 0, reviewApprove: 0, roundTrips: 0, tokens: 0 };
  for (const performance of [
    () => undefined,
    (_role: Role, model: string) => ({ samples: 20, acceptRate: model === "opus" ? 1 : 0,
      reviewApprove: 0, avgRoundTrips: 1, avgTokens: model === "opus" ? 10_000 : 50_000 }),
  ]) {
    for (const deferred of [false, true]) {
      const result = decide(request("implement"), { policy, performance,
        quota: candidate => deferred && candidate.model === "gpt-6-astra" ? { percent: 70, source: "primary" } : undefined,
      });
      assert.ok(result.ok);
      assert.equal(result.assignment.model, deferred ? "opus" : "gpt-6-astra");
      assert.ok(result.assignment.reason.includes("stage 3 performance: static order (weight sum is zero)"));
      const scores = result.assignment.reason.filter(reason => reason.startsWith("stage 3 score "));
      assert.equal(scores.length, 2);
      for (const score of scores) assert.match(score, /acceptRate=0\.000000 reviewApprove=0\.000000 roundTrips=0\.000000 tokens=0\.000000 total=0\.000000$/);
    }
  }
});

test("正規化後も soft 超の降格と hard 超の除外を実績より優先する", () => {
  const policy = createPolicy();
  const result = decide(request("implement"), { policy,
    quota: candidate => candidate.model === "opus" ? undefined : { percent: candidate.model === "gpt-6-astra" ? 90 : 70, source: "primary" },
    performance: (_role, model) => ({ samples: 20, acceptRate: model === "opus" ? 0 : 1,
      reviewApprove: model === "opus" ? 0 : 1, avgRoundTrips: model === "opus" ? 3 : 1, avgTokens: model === "opus" ? 50_000 : 10_000 }),
  });
  assert.ok(result.ok);
  assert.equal(result.assignment.model, "opus");
  assert.equal(result.assignment.reason.filter(reason => reason.startsWith("stage 3 score ")).length, 2);
  assert.ok(!result.assignment.reason.some(reason => reason.startsWith("stage 3 score gpt-6-astra:")));
});

test("policy 制約と依頼の minTier を適用する", () => {
  const input = { policy: createPolicy(), quota: () => undefined, performance: () => undefined };
  const reviewer = decide(request("review"), { ...input, implementerFamily: "anthropic" as const });
  assert.equal(reviewer.ok && reviewer.assignment.family, "openai");
  if (reviewer.ok) assert.match(reviewer.assignment.reason.join(" "), /reviewerDifferentFamily: opus excluded/);
  const implementer = decide(request("implement"), { ...input, orchestratorModel: "gpt-6-astra" });
  assert.equal(implementer.ok && implementer.assignment.model, "gpt-6.1-sol");
  if (implementer.ok) assert.match(implementer.assignment.reason.join(" "), /implementerNotOrchestrator: gpt-6-astra excluded/);
  const policy = createPolicy();
  policy.constraints.push({ kind: "minTierForRole", role: "document", tier: "high" });
  const tier = decide(request("document"), { ...input, policy });
  assert.equal(tier.ok && tier.assignment.model, "opus");
  if (tier.ok) assert.match(tier.assignment.reason.join(" "), /minTierForRole: sonnet excluded/);
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
    writeFileSync(path, JSON.stringify({ roles: { implement: [{ executor: "wrong", model: "custom", family: "anthropic", tier: "low" }] } }));
    assert.throws(() => defaultPolicyTable(), TypeError);
  } finally {
    if (previous === undefined) delete process.env.AGENT_GRAPH_POLICY_JSON;
    else process.env.AGENT_GRAPH_POLICY_JSON = previous;
  }
});
