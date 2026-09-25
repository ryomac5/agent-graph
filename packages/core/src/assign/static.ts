import type { Assignment, Candidate, DelegateRequest, Role } from "../delegate/types.ts";
import { decide } from "./assign.ts";
import { loadPolicy } from "./policy.ts";

export function staticPolicyTable(): Record<Role, Candidate[]> {
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
  return roles;
}

export function defaultPolicyTable(): Record<Role, Candidate[]> {
  return loadPolicy().roles;
}

export function assign(
  req: DelegateRequest,
  table: Record<Role, Candidate[]>,
): { ok: true; assignment: Assignment } | { ok: false; reason: string[] } {
  return decide(req, { policy: { ...loadPolicy(), roles: table }, quota: () => undefined, performance: () => undefined });
}
