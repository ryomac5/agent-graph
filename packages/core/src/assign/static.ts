import type { Assignment, Candidate, DelegateRequest, Role } from "../delegate/types.ts";
import { decide } from "./assign.ts";
import { loadPolicy, getCandidates, ROLES } from "./policy.ts";

export function defaultPolicyTable(): Record<Role, Candidate[]> {
  const policy = loadPolicy();
  return Object.fromEntries(ROLES.map(role => [role, getCandidates(policy, role)])) as Record<Role, Candidate[]>;
}

export function assign(
  req: DelegateRequest,
  table: Record<Role, Candidate[]>,
): { ok: true; assignment: Assignment } | { ok: false; reason: string[] } {
  return decide(req, { policy: { ...loadPolicy(), roles: table }, quota: () => undefined, performance: () => undefined });
}
