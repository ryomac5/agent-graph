import type { Assignment, Candidate, DelegateRequest, ModelFamily, Role, Tier } from "../delegate/types.ts";
import { policyVersion, type Policy } from "./policy.ts";

export type QuotaView = (candidate: Candidate) => { percent: number; source: string } | undefined;
export type PerformanceView = (role: Role, model: string) => {
  samples: number; acceptRate: number; reviewApprove: number; avgRoundTrips: number; avgTokens: number;
} | undefined;
export interface DecisionInput {
  policy: Policy;
  quota: QuotaView;
  performance: PerformanceView;
  orchestratorModel?: string;
  implementerFamily?: ModelFamily;
}
const TIER_RANK: Record<Tier, number> = { low: 0, mid: 1, high: 2 };

export function decide(
  req: DelegateRequest, input: DecisionInput,
): { ok: true; assignment: Assignment } | { ok: false; reason: string[] } {
  const { policy } = input;
  const reason: string[] = [];
  let candidates = [...(policy.roles[req.role] ?? [])];
  reason.push(`stage 1 role ${req.role}: ${candidates.length} candidates`);
  const available: Candidate[] = [];
  const deferred: Candidate[] = [];
  for (const candidate of candidates) {
    const usage = input.quota(candidate);
    if (!usage) available.push(candidate);
    else if (usage.percent >= policy.quota.hardLimitPercent) {
      reason.push(`stage 2 hard: ${candidate.model} excluded at ${usage.percent}% (${usage.source})`);
    } else if (usage.percent >= policy.quota.softLimitPercent) {
      deferred.push(candidate);
      reason.push(`stage 2 soft: ${candidate.model} deferred at ${usage.percent}% (${usage.source})`);
    } else available.push(candidate);
  }
  candidates = [...available, ...deferred];
  reason.push(`stage 2 quota: ${candidates.length} remain`);
  const metrics = candidates.map((candidate) => input.performance(req.role, candidate.model));
  if (candidates.length && metrics.every((value) => value && value.samples >= policy.performance.minSamples)) {
    const weights = policy.performance.weights;
    const score = (index: number): number => {
      const value = metrics[index]!;
      return weights.acceptRate * value.acceptRate + weights.reviewApprove * value.reviewApprove -
        weights.roundTrips * value.avgRoundTrips - weights.tokens * value.avgTokens;
    };
    candidates = candidates.map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => {
        const quotaOrder = Number(a.index >= available.length) - Number(b.index >= available.length);
        return quotaOrder || score(b.index) - score(a.index) || a.index - b.index;
      })
      .map(({ candidate }) => candidate);
    reason.push("stage 3 performance: weighted score order");
  } else reason.push(`stage 3 performance: static order (minimum ${policy.performance.minSamples} samples unavailable)`);
  const { excludeFamily = [], excludeModels = [], minTier } = req.constraints ?? {};
  candidates = candidates.filter((candidate) => {
    if (excludeFamily.includes(candidate.family)) {
      reason.push(`stage 4 excludeFamily: ${candidate.model} excluded (${candidate.family})`);
      return false;
    }
    if (excludeModels.includes(candidate.model)) {
      reason.push(`stage 4 excludeModels: ${candidate.model} excluded`);
      return false;
    }
    if (minTier && TIER_RANK[candidate.tier] < TIER_RANK[minTier]) {
      reason.push(`stage 4 minTier: ${candidate.model} excluded (${candidate.tier} < ${minTier})`);
      return false;
    }
    for (const constraint of policy.constraints) {
      if (constraint.kind === "reviewerDifferentFamily" && req.role === "review" &&
        input.implementerFamily === candidate.family) {
        reason.push(`stage 4 reviewerDifferentFamily: ${candidate.model} excluded (${candidate.family})`);
        return false;
      }
      if (constraint.kind === "implementerNotOrchestrator" && req.role === "implement" &&
        input.orchestratorModel === candidate.model) {
        reason.push(`stage 4 implementerNotOrchestrator: ${candidate.model} excluded`);
        return false;
      }
      if (constraint.kind === "minTierForRole" && req.role === constraint.role &&
        TIER_RANK[candidate.tier] < TIER_RANK[constraint.tier]) {
        reason.push(`stage 4 minTierForRole: ${candidate.model} excluded (${candidate.tier} < ${constraint.tier})`);
        return false;
      }
    }
    return true;
  });
  reason.push(`stage 4 constraints: ${candidates.length} remain`);
  const candidate = candidates[0];
  if (!candidate) return { ok: false, reason: [...reason, "no candidates remain"] };
  return { ok: true, assignment: { ...candidate, reason, policyVersion: policyVersion(policy) } };
}
