import { readFileSync } from "node:fs";
import type { Assignment, Candidate, DelegateRequest, Role, Tier } from "../delegate/types.ts";

const POLICY_VERSION = "static-1";
const TIER_RANK: Record<Tier, number> = { low: 0, mid: 1, high: 2 };
const ROLES: Role[] = ["orchestrate", "implement", "research", "document", "review"];

export function defaultPolicyTable(): Record<Role, Candidate[]> {
  const roles: Record<Role, Candidate[]> = {
    implement: [
      { executor: "codex", model: "gpt-6-astra", family: "openai", tier: "high" },
      { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "mid" },
      { executor: "claude", model: "opus", family: "anthropic", tier: "high" },
    ],
    review: [
      { executor: "claude", model: "fable", family: "anthropic", tier: "high" },
      { executor: "codex", model: "gpt-6-astra", family: "openai", tier: "high" },
    ],
    research: [
      { executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" },
      { executor: "codex", model: "gpt-6-sol", family: "openai", tier: "mid" },
    ],
    document: [
      { executor: "claude", model: "sonnet", family: "anthropic", tier: "mid" },
      { executor: "claude", model: "opus", family: "anthropic", tier: "high" },
    ],
    orchestrate: [
      { executor: "claude", model: "fable", family: "anthropic", tier: "high" },
    ],
  };
  const path = process.env.AGENT_GRAPH_POLICY_JSON;
  if (!path) return roles;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("roles" in parsed)) {
    throw new TypeError("Policy JSON must contain roles");
  }
  const replacement = parsed.roles as Record<string, unknown> | null;
  if (typeof replacement !== "object" || replacement === null ||
      !ROLES.every((role) => Array.isArray(replacement[role]) && replacement[role].every((candidate: unknown) =>
        typeof candidate === "object" && candidate !== null &&
        "executor" in candidate && ["claude", "codex"].includes(String(candidate.executor)) &&
        "model" in candidate && typeof candidate.model === "string" &&
        "family" in candidate && ["anthropic", "openai"].includes(String(candidate.family)) &&
        "tier" in candidate && ["high", "mid", "low"].includes(String(candidate.tier))))) {
    throw new TypeError("Policy JSON roles must be Record<Role, Candidate[]>");
  }
  return replacement as Record<Role, Candidate[]>;
}

export function assign(
  req: DelegateRequest,
  table: Record<Role, Candidate[]>,
): { ok: true; assignment: Assignment } | { ok: false; reason: string[] } {
  const reason = [`role: ${req.role}`];
  let candidates = table[req.role] ?? [];
  reason.push(`role candidates: ${candidates.length}`);
  const { excludeFamily = [], excludeModels = [], minTier } = req.constraints ?? {};
  candidates = candidates.filter((candidate) => !excludeFamily.includes(candidate.family));
  reason.push(`excludeFamily: ${excludeFamily.join(",") || "none"}; remaining: ${candidates.length}`);
  candidates = candidates.filter((candidate) => !excludeModels.includes(candidate.model));
  reason.push(`excludeModels: ${excludeModels.join(",") || "none"}; remaining: ${candidates.length}`);
  if (minTier) candidates = candidates.filter((candidate) => TIER_RANK[candidate.tier] >= TIER_RANK[minTier]);
  reason.push(`minTier: ${minTier ?? "none"}; remaining: ${candidates.length}`);
  const candidate = candidates[0];
  if (!candidate) return { ok: false, reason: [...reason, "no candidates remain"] };
  return { ok: true, assignment: { ...candidate, reason, policyVersion: POLICY_VERSION } };
}
