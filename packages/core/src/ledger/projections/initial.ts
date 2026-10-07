import type { Fact } from "../facts.ts";
import { project, projectNames, projectConversations, projectMessages, projectRuns, projectConnections,
  projectDelegations, projectArtifacts, projectApprovals, projectFindings, collectProvisionalNames,
  type MessageProjection } from "./index.ts";

function projectInitialConversations(facts: Fact[], projection: MessageProjection) {
  // 発言の投影を再利用し、会話の仮名のために同じ本文を再投影しない。
  return projectConversations(facts, collectProvisionalNames(projection));
}

/** 初回は実体別に入力を分け、訂正の依存は全体投影で解決する。 */
export function projectInitial(facts: Fact[]) {
  if (facts.some((fact) => fact.supersedes)) return project(facts);
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    const entity = fact.kind.split(".")[0];
    const group = groups.get(entity) ?? [];
    group.push(fact);
    groups.set(entity, group);
  }
  const collect = (...entities: string[]) => entities.flatMap((entity) => groups.get(entity) ?? []);
  // 大量の発言を、無関係な実体の投影でも整列する処理を避ける。
  const messages = projectMessages(collect("message", "message_membership", "conversation"));
  return {
    ...projectNames(collect("task", "alias")),
    ...projectInitialConversations(collect("task", "conversation", "relation"), messages),
    ...messages,
    runs: projectRuns(collect("run")), connections: projectConnections(collect("connection")),
    delegations: projectDelegations(collect("delegation", "conversation", "run", "project")),
    artifacts: projectArtifacts(collect("artifact")), approvals: projectApprovals(collect("approval", "artifact", "run")),
    findings: projectFindings(collect("finding")),
  };
}
