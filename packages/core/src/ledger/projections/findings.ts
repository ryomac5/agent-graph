import type { Fact, FindingPayload } from "../facts.ts";
import { projectEntityRecords } from "./delegations.ts";

export interface FindingProjection extends Partial<FindingPayload> { id: string }
export interface FindingContext {
  file: string;
  side: "old" | "new";
  context_hash: string;
  start_line: number;
  end_line: number;
}
export function projectFindings(facts: readonly Fact[]): FindingProjection[] {
  return projectEntityRecords<FindingPayload>(facts, "finding");
}
export function remapFinding<T extends Partial<FindingPayload>>(finding: T, target: { artifact_id: string; version: number }, contexts: readonly FindingContext[]): T {
  const matches = contexts.filter((context) => context.context_hash === finding.context_hash
    && context.file === finding.file && context.side === finding.side);
  // 同じ文脈が複数に現れる場合も、位置を推測しない。
  const unique = [...new Map(matches.map((context) => [JSON.stringify(context), context])).values()];
  if (unique.length !== 1) return { ...finding, ...target, state: "needs_check" };
  return { ...finding, ...target, ...unique[0] };
}
export function remapFindings(findings: readonly FindingProjection[], target: { artifact_id: string; version: number }, contexts: readonly FindingContext[]): FindingProjection[] {
  return findings.map((finding) => remapFinding(finding, target, contexts));
}
