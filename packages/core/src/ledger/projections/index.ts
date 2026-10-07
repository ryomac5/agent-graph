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

export * from "./roots.ts";
import { projectRoots } from "./roots.ts";
import { projectConversationIds } from "./relations.ts";
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
  const conversations = projectConversations(facts, collectProvisionalNames(messages));
  const runs = projectRuns(facts);
  const ids = projectConversationIds(facts);
  const latest = new Map<string, typeof runs[number]>();
  for (const run of runs) {
    const id = ids.get(run.conversation_id) ?? run.conversation_id;
    if (!latest.has(id) || run.generation > latest.get(id)!.generation) latest.set(id, run);
  }
  const activity = new Map<string, string>();
  const messageTimes = new Map(messages.messages.map(row => [row.id, row.source_ts]));
  for (const membership of messages.message_memberships) {
    const ts = membership.message_id && messageTimes.get(membership.message_id);
    if (membership.active && membership.conversation_id && ts && ts > (activity.get(membership.conversation_id) ?? "")) activity.set(membership.conversation_id, ts);
  }
  const roots = projectRoots(conversations.conversations.map(row => {
    const run = latest.get(row.id);
    const task = conversations.tasks.find(task => task.id === row.task_id);
    return { ...row, project: task?.project ?? row.repository_id,
      state: run?.state, last_activity_ts: [activity.get(row.id), run?.last_evidence_ts, run?.ended_ts, run?.started_ts].filter((ts): ts is string => !!ts).sort().at(-1) };
  }), conversations.relations);
  return {
    roots,
    ...projectNames(facts),
    // 発言の投影を再利用し、会話の名前のために同じ本文を再投影しない。
    ...conversations,
    ...messages,
    runs,
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
