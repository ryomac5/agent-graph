import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function runDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  if (!isAbsolute(stateHome)) throw new TypeError("State directory must be an absolute path");
  return join(stateHome, "agent-graph", "run");
}
