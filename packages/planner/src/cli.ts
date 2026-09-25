#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openPlanner, requestDecision, runGraph, type RunOptions } from "./run.ts";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    session: { type: "string" }, spec: { type: "string" }, "max-parallel": { type: "string" }, "no-pr": { type: "boolean" },
  } });
  const [command, task] = positionals;
  if (!values.session || !["run", "status", "approve", "reject", "retry"].includes(command ?? "") || positionals.length > (["approve", "reject", "retry"].includes(command!) ? 2 : 1)) {
    throw new Error("Usage: agent-graph-plan run|status|approve|reject|retry [task] --session <id> [--spec path] [--max-parallel n] [--no-pr]");
  }
  const options: RunOptions = { repo: process.cwd(), session: values.session, specPath: values.spec,
    maxParallel: values["max-parallel"] === undefined ? undefined : Number(values["max-parallel"]), noPr: values["no-pr"] };
  if (command === "run") {
    const result = await runGraph(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.tasks.some((task) => task.state !== "done")) process.exitCode = 1;
  } else if (command === "status") {
    const context = openPlanner(options.repo, options.session, options.specPath);
    try {
      const graph = context.store.findGraph(context.key, options.session, context.fingerprint);
      if (!graph) throw new Error("Graph not found; run it first");
      console.log(JSON.stringify({ graph, tasks: context.store.listTasks(graph.id) }, null, 2));
    } finally { context.store.close(); }
  } else {
    if (!task) throw new Error("Task id is required");
    requestDecision(options, task, command as "approve" | "reject" | "retry");
    console.log(`${task}: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
