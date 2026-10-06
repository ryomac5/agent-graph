import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

function resolveStateDirectory(env: Record<string, string | undefined>, home: string): string {
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  if (!isAbsolute(stateHome)) throw new TypeError("State directory must be an absolute path");
  return join(stateHome, "agent-graph");
}

export function ledgerDbPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(resolveStateDirectory(env, home), "agent-graph.db");
}

export function runnerSocketPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(resolveStateDirectory(env, home), "runner.sock");
}

export function secureSocketDirectory(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Socket directory must be owned by the current user");
  }
  chmodSync(directory, 0o700);
}
