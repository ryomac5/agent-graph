import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

function resolveStateDirectory(env: Record<string, string | undefined>, home: string): string {
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  if (!isAbsolute(stateHome)) throw new TypeError("State directory must be an absolute path");
  return join(stateHome, "agent-graph");
}

export function ledgerDbPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(resolveStateDirectory(env, home), "agent-graph.db");
}

export function hookOutboxPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return join(resolveStateDirectory(env, home), "outbox");
}
