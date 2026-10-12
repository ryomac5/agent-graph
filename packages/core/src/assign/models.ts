import { decide, type DecisionInput } from "./assign.ts";
import { getCandidates, ROLES, WEIGHTS, type Policy } from "./policy.ts";
import type { Executor, Role, Weight } from "../delegate/types.ts";

export interface ModelUsage {
  quota?: DecisionInput["quota"] | Record<string, number>;
  orchestratorModel?: DecisionInput["orchestratorModel"];
  implementerFamily?: DecisionInput["implementerFamily"];
}
export function resolveModel(policy: Policy, role: Role, weight: Weight = "standard", usage: ModelUsage = {}): { executor: Executor; model: string; effort?: string; reason: string[] } {
  if (!ROLES.includes(role)) throw new TypeError("Invalid role");
  if (!WEIGHTS.includes(weight)) throw new TypeError("Invalid weight");
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("Invalid usage");
  if (usage.implementerFamily !== undefined && !["anthropic", "openai", "google"].includes(usage.implementerFamily)) throw new TypeError("Invalid implementerFamily");
  if (usage.orchestratorModel !== undefined && typeof usage.orchestratorModel !== "string") throw new TypeError("Invalid orchestratorModel");
  const quota = usage.quota;
  if (quota !== undefined && typeof quota !== "function" && (!quota || typeof quota !== "object" || Array.isArray(quota) || Object.values(quota).some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0))) throw new TypeError("Invalid quota usage");
  const decision = decide({ role, weight, title: "Model resolution", task: "Model resolution", accept: [] }, {
    policy, quota: typeof quota === "function" ? quota : candidate => {
      const percent = quota?.[candidate.model] ?? quota?.[candidate.executor] ?? quota?.[candidate.family];
      return percent === undefined ? undefined : { percent, source: "usage" };
    }, performance: () => undefined, orchestratorModel: usage.orchestratorModel, implementerFamily: usage.implementerFamily,
  });
  if (!decision.ok) throw new TypeError(decision.reason.join("; "));
  const { executor, model, effort, reason } = decision.assignment;
  return { executor, model, ...(effort ? { effort } : {}), reason };
}
export function modelNotice(policy: Policy): string {
  const describe = (role: Role, weight: Weight = "standard") => {
    const c = getCandidates(policy, role, weight)[0];
    return c ? [c.executor, c.model, c.effort].filter(Boolean).join(" ") : "候補なし";
  };
  return `割り当て: 実装 重=${describe("implement", "heavy")} / 標準=${describe("implement")} / 軽=${describe("implement", "light")}。\n` +
    `レビュー 重=${describe("review", "heavy")} / 標準=${describe("review")} / 軽=${describe("review", "light")}。文書 重=${describe("document", "heavy")} / 標準=${describe("document")} / 軽=${describe("document", "light")}。\n` +
    `校正=${describe("proofread")}。助言=${describe("advisor")}。検証=${describe("verify")}。調査=${describe("research")}。根=${describe("orchestrate")}。\n` +
    `重さの基準: ${Object.entries(policy.criteria).flatMap(([role, bands]) => Object.entries(bands ?? {}).map(([weight, text]) => `${role}.${weight}: ${text}`)).join(" / ")}`;
}
