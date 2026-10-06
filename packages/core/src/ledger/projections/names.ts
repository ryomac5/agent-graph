import type { Fact } from "../facts.ts";
import { compareFacts, compareText, projectEntities } from "./relations.ts";
import type { ProjectedEntity } from "./relations.ts";

export type ProjectedTask = ProjectedEntity<"task">;
export type ProjectedAlias = ProjectedEntity<"alias">;
export interface NameProjection {
  tasks: ProjectedTask[];
  aliases: ProjectedAlias[];
}

// 保存側は同一の append トランザクション内でこの結果を作成の事実へ書く。
// 一括の候補も安定した順で割り当て、外部の counter は参照しない。
export function allocateTaskNames(facts: readonly Fact[]): { task_id: string; name: string }[] {
  const tasks = projectEntities(facts, "task");
  const conversations = projectEntities(facts, "conversation", undefined,
    (fact) => [fact.source.startsWith("host-") ? 1 : 0]);
  const unattendedTasks = new Set(conversations.filter((conversation) => conversation.type === "unattended")
    .map((conversation) => conversation.task_id));
  const interactiveTasks = new Set(conversations.filter((conversation) => conversation.type === "interactive")
    .map((conversation) => conversation.task_id));
  const creationFacts = new Map<string, Fact>();
  for (const fact of [...facts].sort(compareFacts)) {
    if (fact.kind === "task.created" && !creationFacts.has(fact.subject.slice("task:".length))) {
      creationFacts.set(fact.subject.slice("task:".length), fact);
    }
  }
  const counters = new Map<string, number>();
  const usedNames = new Set<string>();
  for (const task of tasks) {
    if (!task.name) continue;
    if (usedNames.has(task.name)) throw new Error(`作業の名前が重複しています: ${task.name}`);
    usedNames.add(task.name);
    if (task.project && task.name.startsWith(`${task.project}-`)) {
      const suffix = task.name.slice(task.project.length + 1);
      const number = /^\d+$/.test(suffix) ? Number(suffix) : 0;
      if (!Number.isSafeInteger(number)) throw new RangeError("作業の番号は安全な整数に限ります");
      counters.set(task.project, Math.max(counters.get(task.project) ?? 0, number));
    }
  }
  const eligible = tasks.filter((task) => {
    const creation = creationFacts.get(task.id);
    // 最初の利用者指示と画面での作成は ui、委譲の作成は intake として記録する。
    return creation && task.project && !task.name
      && creation.source === "ui" && (!unattendedTasks.has(task.id) || interactiveTasks.has(task.id));
  }).sort((left, right) => compareFacts(creationFacts.get(left.id)!, creationFacts.get(right.id)!) || compareText(left.id, right.id));
  return eligible.map((task) => {
    const project = task.project!;
    let number = counters.get(project) ?? 0;
    do {
      number += 1;
      if (!Number.isSafeInteger(number)) throw new RangeError("作業の番号を使い切りました");
    } while (usedNames.has(`${project}-${number}`));
    counters.set(project, number);
    usedNames.add(`${project}-${number}`);
    return { task_id: task.id, name: `${project}-${number}` };
  });
}
export function projectNames(facts: readonly Fact[]): NameProjection {
  return {
    tasks: projectEntities(facts, "task"),
    aliases: projectEntities(facts, "alias", (payload, id) =>
      payload.entity_id && payload.kind && payload.name ? JSON.stringify([payload.entity_id, payload.kind, payload.name]) : id),
  };
}
export function searchNames(projection: NameProjection, query: string, kind: "name" | "kit" | "legacy" = "name"): string[] {
  return [...new Set(kind === "name"
    ? projection.tasks.filter((task) => task.name === query).map((task) => task.id)
    : projection.aliases.filter((alias) => alias.kind === kind && alias.name === query && alias.entity_id)
      .map((alias) => alias.entity_id!))].sort(compareText);
}
