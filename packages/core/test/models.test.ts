import assert from "node:assert/strict";
import test from "node:test";
import { defaultPolicy, getCandidates, loadPolicy, mergePolicy, parsePolicyToml } from "../src/assign/policy.ts";
import { modelNotice, resolveModel } from "../src/assign/models.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEGACY = '[[roles.implement]]\nexecutor = "claude"\nmodel = "custom-opus"\nfamily = "anthropic"\ntier = "high"\n';
test("旧い TOML は standard の候補として読み、重さ別の既定を残す", t => {
  const root = mkdtempSync(join(tmpdir(), "models-policy-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "policy.toml"); writeFileSync(path, LEGACY);
  const policy = loadPolicy({ path, env: {} });
  assert.equal(resolveModel(policy, "implement", "standard").model, "custom-opus");
  assert.equal(resolveModel(policy, "implement", "heavy").effort, "xhigh");
  assert.equal(resolveModel(policy, "implement", "light").model, "gpt-6.1-sol");
});
test("段ごとのモデルと深さと、standard の継承を解決する", () => {
  const p = defaultPolicy();
  for (const [weight, model, effort] of [["light", "gpt-6.1-sol", "low"], ["standard", "gpt-6-astra", "high"], ["heavy", "gpt-6-astra", "xhigh"]] as const) {
    const result = resolveModel(p, "implement", weight); assert.equal(result.executor, "codex"); assert.equal(result.model, model); assert.equal(result.effort, effort);
  }
  assert.equal(resolveModel(p, "review", "standard").model, "opus");
  assert.equal(resolveModel(p, "review", "heavy").model, "fable");
  assert.equal(resolveModel(p, "document", "light").model, "sonnet");
  for (const weight of ["light", "standard", "heavy"] as const) assert.equal(resolveModel(p, "advisor", weight).model, "fable");
  assert.equal(resolveModel(p, "proofread").executor, "antigravity");
});
test("hard 上限で候補を飛ばし、soft 上限で後へ回す。全候補が外れれば失敗する", () => {
  const p = defaultPolicy();
  for (const percent of [70, 90, 95]) {
    const result = resolveModel(p, "implement", "heavy", { quota: { "gpt-6-astra": percent } });
    assert.equal(result.model, "opus"); assert.match(result.reason.join(" "), /quota/);
  }
  assert.equal(resolveModel(p, "implement", "heavy", { quota: { openai: 90 } }).model, "opus");
  assert.throws(() => resolveModel(p, "implement", "heavy", { quota: { codex: 90, claude: 90 } }), /no candidates/);
});
test("実装者と根の分離、レビューの系統、役割の最低水準を守る", () => {
  const p = defaultPolicy();
  assert.equal(resolveModel(p, "implement", "heavy", { orchestratorModel: "gpt-6-astra" }).model, "opus");
  assert.equal(resolveModel(p, "review", "heavy", { implementerFamily: "anthropic" }).executor, "codex");
  assert.equal(resolveModel(p, "review", "heavy", { implementerFamily: "openai" }).model, "fable");
  p.constraints.push({ kind: "minTierForRole", role: "document", tier: "high" });
  assert.throws(() => resolveModel(p, "document", "light"), /minTierForRole/);
});
test("重さ別 TOML と覚え書きと基準の日本語とエスケープを読む", () => {
  const patch = parsePolicyToml(`[[roles.proofread.standard]]
executor = "antigravity"
model = "gemini-3.8-flash-high"
family = "google"
tier = "high"
effort = "high"
[criteria.implement]
heavy = "設計と # 安全の変更。"
[[modelNotes]]
model = "gpt-6-astra"
latest = false
strength = "SWE-bench で最上位。"
specialties = "実装と\\n設計"
`);
  const policy = mergePolicy(defaultPolicy(), patch);
  assert.equal(resolveModel(policy, "proofread").effort, "high");
  assert.equal(policy.criteria.implement?.heavy, "設計と # 安全の変更。");
  assert.equal(policy.modelNotes[0].specialties, "実装と\n設計");
  assert.equal(getCandidates(policy, "proofread", "heavy").length, 1);
});
test("notice は選択順、モデルと深さ、基準と強さの覚え書きを伝える", () => {
  const notice = modelNotice(defaultPolicy());
  assert.match(notice, /実装 重=codex gpt-6-astra xhigh \/ 標準=codex gpt-6-astra high \/ 軽=codex gpt-6.1-sol low/);
  assert.match(notice, /校正=antigravity gemini-3.8-flash-high。助言=claude fable/);
  assert.match(notice, /SWE-bench で最上位/); assert.match(notice, /日本語の性能が高い/);
  assert.match(notice, /複数のパッケージ/); assert.match(notice, /最新と強さは別/);
});
test("不正な役割、重さ、quota、系統と候補の不整合を拒否する", () => {
  const p = defaultPolicy();
  assert.throws(() => resolveModel(p, "bad" as never), /role/);
  assert.throws(() => resolveModel(p, "implement", "bad" as never), /weight/);
  assert.throws(() => resolveModel(p, "implement", "standard", { quota: { codex: Number.NaN } }), /quota/);
  assert.throws(() => mergePolicy(p, { roles: { proofread: { standard: [{ executor: "antigravity", model: "g", family: "openai", tier: "high" }] } } }), /family/);
});

test("標準への継承を保存でき、編集元の参照を割り当てへ持ち込まない", () => {
  const patch = { roles: { implement: { standard: getCandidates(defaultPolicy(), "implement") } } };
  const merged = mergePolicy(defaultPolicy(), patch);
  assert.equal(resolveModel(merged, "implement", "heavy").effort, "high");
  patch.roles.implement.standard[0].model = "mutated";
  assert.equal(resolveModel(merged, "implement").model, "gpt-6-astra");
});
