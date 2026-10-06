import type { ArtifactPayload, Fact } from "../facts.ts";
import { prepareProjectionFacts } from "./delegations.ts";

export type GitAttribution = "confirmed" | "inferred" | "joint" | "unknown";
export interface GitAttributionEvidence {
  run_id: string;
  repository_id: string;
  worktree_id: string;
  base_sha: string;
  head_sha: string;
  dedicated_worktree?: boolean;
  range_commits?: string[];
  commit_result?: { success: boolean; head_sha?: string; help?: boolean };
  shared_command?: { success: boolean; matched_run_id: string; head_sha?: string; help?: boolean };
  concurrent_run_ids?: string[];
}
export interface ArtifactProjection extends Partial<ArtifactPayload> {
  id: string;
  run_id: string;
  version: number;
  attribution: GitAttribution;
}
export function classifyGitAttribution(artifact: Partial<ArtifactPayload>, evidence: readonly GitAttributionEvidence[]): GitAttribution {
  const matching = evidence.filter((item) => item.run_id === artifact.run_id
    && item.repository_id === artifact.repository_id && item.worktree_id === artifact.worktree_id
    && item.base_sha === artifact.base_sha && item.head_sha === artifact.head_sha);
  if (matching.some((item) => new Set(item.concurrent_run_ids).size > 1 && item.concurrent_run_ids?.includes(item.run_id))) return "joint";
  if (matching.some((item) => (item.dedicated_worktree && item.range_commits?.includes(item.head_sha))
    || (item.commit_result?.success && !item.commit_result.help && item.commit_result.head_sha === artifact.head_sha))) return "confirmed";
  if (matching.some((item) => item.shared_command?.success && !item.shared_command.help
    && item.shared_command.matched_run_id === artifact.run_id && item.shared_command.head_sha === artifact.head_sha)) return "inferred";
  return "unknown";
}
export function projectArtifacts(facts: readonly Fact[], evidence: readonly GitAttributionEvidence[] = []): ArtifactProjection[] {
  const records = new Map<string, ArtifactProjection>();
  const subjects = new Map<string, string>();
  for (const fact of prepareProjectionFacts(facts)) {
    if (!fact.kind.startsWith("artifact.") || !fact.payload) continue;
    const payload = fact.payload as Partial<ArtifactPayload>;
    const subjectKey = subjects.get(fact.subject);
    const runId = payload.run_id ?? (subjectKey ? records.get(subjectKey)?.run_id : undefined);
    const key = runId !== undefined && payload.version !== undefined
      ? JSON.stringify([runId, payload.version]) : subjectKey;
    if (!key) continue;
    subjects.set(fact.subject, key);
    const previous = records.get(key);
    const merged = { ...previous, ...payload, run_id: runId };
    const attribution = payload.attribution !== undefined
      ? (fact.confidence === "confirmed" ? payload.attribution : payload.attribution === "confirmed" ? "inferred" : payload.attribution)
      : previous?.attribution ?? "unknown";
    const subjectId = fact.subject.slice("artifact:".length);
    const id = previous?.id ?? ([...records.values()].some((record) => record.id === subjectId) ? `${subjectId}@${merged.version}` : subjectId);
    records.set(key, { ...merged, id,
      run_id: merged.run_id!, version: merged.version!, attribution });
  }
  return [...records.values()].map((artifact) => {
    const derived = classifyGitAttribution(artifact, evidence);
    return { ...artifact, attribution: derived === "unknown" ? artifact.attribution : derived };
  }).sort((left, right) => left.run_id.localeCompare(right.run_id) || left.version - right.version || left.id.localeCompare(right.id));
}
