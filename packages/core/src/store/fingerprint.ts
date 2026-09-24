import { createHash } from "node:crypto";

const FINGERPRINT_LENGTH = 16;

export function fingerprint(graph: {
  goal: string;
  tasks: { id: string; role: "orchestrate" | "implement" | "research" | "document" | "review" }[];
}): string {
  const body = [
    graph.goal.trim(),
    ...graph.tasks.map((task) => `${task.id}:${task.role}`).sort(),
  ].join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
