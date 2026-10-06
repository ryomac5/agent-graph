import type { Fact } from "../../core/src/ledger/facts.ts";
import { projectApprovals, type ApprovalProjection } from "../../core/src/ledger/projections/approvals.ts";

// 実機の確認で承認を引き出す操作。読み取りだけの Bash は既定の方式でも承認なしで動くため、書き込みを含める。
export const APPROVAL_COMMANDS = {
  claude: "touch hosts-approved.txt && printf HOSTS-APPROVED",
  claudeInterrupt: "touch hosts-interrupt.txt && sleep 60",
  codex: "touch codex-approved.txt && printf CODEX-APPROVED",
} as const;

function describeToolUses(facts: readonly Fact[]): string[] {
  const tools: string[] = [];
  for (const fact of facts) {
    const body = fact.kind === "message.created" ? fact.payload?.body : undefined;
    if (!Array.isArray(body)) continue;
    for (const block of body) {
      if (!block || typeof block !== "object" || Array.isArray(block) || block.type !== "tool_use") continue;
      tools.push(`${String(block.name)} ${JSON.stringify(block.input)}`);
    }
  }
  return tools;
}

/**
 * sinceSeq より後に出た、指定した実行の保留中の承認を返す。まだ無ければ undefined を返す。
 * 承認の要求なしにターンが idle で終わったら、承認が要らない操作として動いたので、待たずに失敗させる。
 */
export function findPendingApproval(facts: readonly Fact[], runId: string, sinceSeq: number): ApprovalProjection | undefined {
  const later = facts.filter((fact) => fact.seq > sinceSeq);
  const created = new Set(later.filter((fact) => fact.kind === "approval.created" && fact.payload?.run_id === runId)
    .map((fact) => fact.subject.slice("approval:".length)));
  const pending = projectApprovals(facts).find((approval) => created.has(approval.id) && approval.state === "pending");
  if (pending) return pending;
  const finished = later.some((fact) => fact.subject === `run:${runId}` && fact.kind === "run.state_changed"
    && ["idle", "ended", "failed"].includes(String(fact.payload?.state)));
  if (finished && created.size === 0) {
    const tools = describeToolUses(later);
    throw new Error(`Turn of ${runId} finished without an approval request; tools ran without approval: ${tools.length ? tools.join("; ") : "none"}`);
  }
  return undefined;
}
