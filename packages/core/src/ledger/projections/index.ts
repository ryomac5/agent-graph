import type { Fact } from "../facts.ts";
import { projectApprovals } from "./approvals.ts";
import { projectArtifacts } from "./artifacts.ts";
import { projectConnections } from "./connections.ts";
import { collectProvisionalNames, projectConversations } from "./conversations.ts";
import { projectDelegations } from "./delegations.ts";
import { projectFindings } from "./findings.ts";
import { projectMessages } from "./messages.ts";
import { projectNames } from "./names.ts";
import { projectRuns } from "./runs.ts";
import { projectProjects, projectUnsupportedObservations } from "./projects.ts";

export * from "./approvals.ts";
export * from "./artifacts.ts";
export * from "./connections.ts";
export * from "./conversations.ts";
export * from "./delegations.ts";
export * from "./findings.ts";
export * from "./messages.ts";
export * from "./names.ts";
export * from "./relations.ts";
export * from "./runs.ts";
export * from "./projects.ts";

export function project(facts: readonly Fact[]) {
  const messages = projectMessages(facts);
  return {
    ...projectNames(facts),
    // 発言の投影を再利用し、会話の名前のために同じ本文を再投影しない。
    ...projectConversations(facts, collectProvisionalNames(messages)),
    ...messages,
    runs: projectRuns(facts),
    connections: projectConnections(facts),
    delegations: projectDelegations(facts),
    artifacts: projectArtifacts(facts),
    approvals: projectApprovals(facts),
    findings: projectFindings(facts),
    projects: projectProjects(facts),
    unsupported_observations: projectUnsupportedObservations(facts),
  };
}

export type Projection = ReturnType<typeof project>;
