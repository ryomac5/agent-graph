import { runGraph, type RunOptions } from "../../planner/src/run.ts";
import { connectIntake } from "../../planner/src/intake-client.ts";

const options = JSON.parse(process.argv[2]) as RunOptions;
try {
  const result = await runGraph(options, { connect: (connection) => connectIntake({ ...connection,
    socketPath: process.env.AGENT_GRAPH_RUNNER_SOCKET }) });
  console.log(JSON.stringify(result));
  if (result.tasks.some((task) => task.state !== "done")) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
}
