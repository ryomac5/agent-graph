import type { Assignment, Candidate, DelegateRequest, ModelFamily, Role, Tier } from "../delegate/types.ts";
import { getCandidates, policyVersion, type Policy } from "./policy.ts";

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

function normalizeMetric(values: number[], lowerIsBetter: boolean): number[] {
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  if (minimum === maximum) return values.map(() => 0);
  return values.map(value => (lowerIsBetter ? maximum - value : value - minimum) / (maximum - minimum));
}

export function decide(
  req: DelegateRequest, input: DecisionInput,
): { ok: true; assignment: Assignment } | { ok: false; reason: string[] } {
  const { policy } = input;
  const reason: string[] = [];
  let candidates = [...getCandidates(policy, req.role, req.weight)];
  reason.push(`stage 1 role ${req.role} weight ${req.weight ?? "standard"}: ${candidates.length} candidates`);
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
  const weights = policy.performance.weights;
  const weightSum = weights.acceptRate + weights.reviewApprove + weights.roundTrips + weights.tokens;
  const metrics = candidates.map((candidate) => input.performance(req.role, candidate.model));
  if (weightSum === 0) {
    for (const candidate of candidates) reason.push(`stage 3 score ${candidate.model}: acceptRate=0.000000 reviewApprove=0.000000 roundTrips=0.000000 tokens=0.000000 total=0.000000`);
    reason.push("stage 3 performance: static order (weight sum is zero)");
  } else if (candidates.length && metrics.every((value) => value && value.samples >= policy.performance.minSamples)) {
    const acceptRate = normalizeMetric(metrics.map(value => value!.acceptRate), false);
    const reviewApprove = normalizeMetric(metrics.map(value => value!.reviewApprove), false);
    const roundTrips = normalizeMetric(metrics.map(value => value!.avgRoundTrips), true);
    const tokens = normalizeMetric(metrics.map(value => value!.avgTokens), true);
    const scores = candidates.map((candidate, index) => {
      const terms = {
        acceptRate: acceptRate[index] * (weights.acceptRate / weightSum),
        reviewApprove: reviewApprove[index] * (weights.reviewApprove / weightSum),
        roundTrips: roundTrips[index] * (weights.roundTrips / weightSum),
        tokens: tokens[index] * (weights.tokens / weightSum),
      };
      const total = terms.acceptRate + terms.reviewApprove + terms.roundTrips + terms.tokens;
      reason.push(`stage 3 score ${candidate.model}: ${Object.entries(terms).map(([key, value]) => `${key}=${value.toFixed(6)}`).join(" ")} total=${total.toFixed(6)}`);
      return total;
    });
    candidates = candidates.map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => {
        const quotaOrder = Number(a.index >= available.length) - Number(b.index >= available.length);
        return quotaOrder || scores[b.index] - scores[a.index] || a.index - b.index;
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
