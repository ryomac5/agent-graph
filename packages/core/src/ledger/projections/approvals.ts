import type { ApprovalPayload, Fact } from "../facts.ts";
import { projectArtifacts } from "./artifacts.ts";
import { compareProjectionFacts, prepareProjectionFacts, projectEntityRecords } from "./delegations.ts";

export interface ApprovalProjection extends Partial<ApprovalPayload> {
  id: string;
  state: string;
  // 要求の事実の時刻。受け箱の待ち時間の起点になる。
  requested_ts?: string;
}
export function projectApprovals(facts: readonly Fact[]): ApprovalProjection[] {
  const active = prepareProjectionFacts(facts);
  const artifacts = projectArtifacts(facts);
  return projectEntityRecords<ApprovalPayload>(facts, "approval").map((record) => {
    const approval: ApprovalProjection = { ...record, state: record.state ?? "pending" };
    const original = artifacts.find((artifact) => artifact.id === approval.artifact_id);
    if (original && approval.patch_hash && approval.state !== "revoked") {
      const successors = collectArtifactSuccessors(facts, original.id);
      if (artifacts.some((artifact) => successors.has(artifact.id) && artifact.patch_hash !== undefined && artifact.patch_hash !== approval.patch_hash)) {
        approval.state = "stale";
        approval.reason = "artifact patch_hash changed";
      }
    }
    const requested = active.find((fact) => fact.subject === `approval:${record.id}` && (fact.kind === "approval.created" || fact.kind === "approval.corrected"));
    if (requested) approval.requested_ts = requested.source_ts;
    const resolved = active.some((fact) => fact.subject === `approval:${record.id}` && (fact.kind === "approval.resolved" || fact.kind === "approval.answered"));
    if (requested && !resolved && ["pending", "requested", "waiting", "waiting_approval"].includes(approval.state)) {
      const expired = active.some((fact) => fact.subject === `run:${approval.run_id}` && compareProjectionFacts(fact, requested) > 0
        && (fact.kind === "run.interrupt_requested" || ((fact.kind === "run.state_changed" || fact.kind === "run.updated")
          && (fact.payload?.cause === "restart" || fact.payload?.cause === "interrupted" || fact.payload?.reason === "restart" || fact.payload?.reason === "interrupted"))));
      if (expired) { approval.state = "expired"; approval.reason = "run restarted or interrupted"; }
    }
    return approval;
  });
}

export function collectArtifactSuccessors(facts: readonly Fact[], originalId: string): Set<string> {
  const artifacts = projectArtifacts(facts);
  const successors = new Set([originalId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const artifact of artifacts) {
      if (successors.has(artifact.id)) continue;
      const follows = artifact.previous_artifact_id && successors.has(artifact.previous_artifact_id)
        || artifacts.some((previous) => successors.has(previous.id)
          && artifact.run_id === previous.run_id && artifact.version > previous.version);
      if (follows) { successors.add(artifact.id); grew = true; }
    }
  }
  return successors;
}

export function canMergeArtifact(facts: readonly Fact[], artifactId: string): boolean {
  const artifact = projectArtifacts(facts).find((entry) => entry.id === artifactId);
  return Boolean(artifact?.patch_hash && projectApprovals(facts).some((approval) => approval.state === "approved"
    && approval.patch_hash === artifact.patch_hash && approval.artifact_id
    && collectArtifactSuccessors(facts, approval.artifact_id).has(artifactId)));
}
