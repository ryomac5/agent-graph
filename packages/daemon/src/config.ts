import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_PORT = 7420;

export function readDashboardPort(env: NodeJS.ProcessEnv = process.env, home = homedir()): number {
  const override = env.AGENT_GRAPH_PORT;
  if (override !== undefined) return parsePort(override);
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  if (!isAbsolute(configHome)) throw new TypeError("Config directory must be an absolute path");
  let contents: string;
  try {
    contents = readFileSync(join(configHome, "agent-graph", "config.toml"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_PORT;
    throw error;
  }
  let dashboard = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      dashboard = section[1] === "dashboard";
      continue;
    }
    if (!dashboard) continue;
    const port = line.match(/^\s*port\s*=\s*(\d+)\s*(?:#.*)?$/);
    if (port) return parsePort(port[1]);
  }
  return DEFAULT_PORT;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port > 65535) {
    throw new RangeError("Dashboard port must be an integer from 0 to 65535");
  }
  return port;
}
