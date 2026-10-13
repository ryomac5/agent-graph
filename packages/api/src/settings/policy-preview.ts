import { decide, type DecisionInput } from "../../../core/src/assign/assign.ts";
import { getCandidates, ROLES, WEIGHTS, type Policy } from "../../../core/src/assign/policy.ts";
import type { Candidate, DelegateRequest, Role, Weight } from "../../../core/src/delegate/types.ts";

export const POLICY_HISTORY_LIMIT = 100;
export const POLICY_EXAMPLE_LIMIT = 5;
export interface PastDelegation {
  id: string;
  request: DelegateRequest;
  context: Omit<DecisionInput, "policy">;
  description?: string;
  timestamp?: string;
}
type PreviewDecision = { ok: boolean; assignment?: Pick<Candidate, "executor" | "model" | "effort"> };
export interface PolicyPreview {
  token: string;
  total: number;
  changed: number;
  roleChanges: { role: Role; bands: { weight: Weight; before: Candidate[]; after: Candidate[] }[] }[];
  rows: { id: string; description: string; timestamp: string | null; role: Role; before: PreviewDecision; after: PreviewDecision }[];
}
function readAssignment(decision: ReturnType<typeof decide>): PreviewDecision {
  if (!decision.ok) return { ok: false };
  const { executor, model, effort } = decision.assignment;
  // 理由や policyVersion の変化は、割り当ての変更として数えない。
  return { ok: true, assignment: { executor, model, ...(effort ? { effort } : {}) } };
}
export function buildPolicyPreview(token: string, before: Policy, after: Policy, history: PastDelegation[]): PolicyPreview {
  const roleChanges = ROLES.flatMap(role => {
    const bands = WEIGHTS.flatMap(weight => {
      const old = getCandidates(before, role, weight);
      const next = getCandidates(after, role, weight);
      return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ weight, before: old, after: next }];
    });
    return bands.length ? [{ role, bands }] : [];
  });
  const recent = [...history].sort((a, b) => (Date.parse(b.timestamp ?? "") || 0) - (Date.parse(a.timestamp ?? "") || 0)).slice(0, POLICY_HISTORY_LIMIT);
  const rows: PolicyPreview["rows"] = [];
  let changed = 0;
  for (const past of recent) {
    const old = readAssignment(decide(past.request, { ...past.context, policy: before }));
    const next = readAssignment(decide(past.request, { ...past.context, policy: after }));
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    changed += 1;
    if (rows.length < POLICY_EXAMPLE_LIMIT) rows.push({ id: past.id,
      description: (past.description ?? (past.request.title.trim() || past.request.task.trim())).replace(/\s+/g, " ").trim(),
      timestamp: past.timestamp ?? null, role: past.request.role, before: old, after: next });
  }
  return { token, total: recent.length, changed, roleChanges, rows };
}
