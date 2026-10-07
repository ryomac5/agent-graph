#!/usr/bin/env node
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { startShim } from "./index.ts";

const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
if (!isAbsolute(state)) throw new TypeError("State directory must be absolute");
const shim = startShim({ path: process.env.AGENT_GRAPH_RUNNER_SOCKET || join(state, "agent-graph", "runner.sock"),
  input: process.stdin, output: process.stdout });
process.once("SIGTERM", () => { shim.close(); process.stdin.destroy(); });
process.once("SIGINT", () => { shim.close(); process.stdin.destroy(); });
