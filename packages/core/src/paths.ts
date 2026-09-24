import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const REPO_HASH_LENGTH = 8;

export function repoKey(rootPath: string): string {
  if (!isAbsolute(rootPath)) throw new TypeError("Git root must be an absolute path");
  const hash = createHash("sha256").update(rootPath).digest("hex").slice(0, REPO_HASH_LENGTH);
  return `${basename(rootPath)}-${hash}`;
}

export function stateDbPath(
  key: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (!key || key === "." || key === ".." || /[/\\]/.test(key)) {
    throw new TypeError("Repository key must be a single path component");
  }
  const stateHome = env.XDG_STATE_HOME || join(home, ".local", "state");
  if (!isAbsolute(stateHome)) throw new TypeError("State directory must be an absolute path");
  return join(stateHome, "agent-graph", key, "agent-graph.db");
}
