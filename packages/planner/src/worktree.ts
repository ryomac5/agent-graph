import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, matchesGlob } from "node:path";
import { repoKey } from "../../core/src/paths.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function component(value: string): string {
  if (!value || value === "." || value === ".." || /[/\\]/.test(value)) throw new TypeError("Invalid worktree component");
  return value;
}

function root(repo: string, session: string): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  if (!isAbsolute(cache)) throw new TypeError("Cache directory must be absolute");
  const gitRoot = git(repo, "rev-parse", "--show-toplevel");
  return join(cache, "agent-graph", "worktrees", repoKey(gitRoot), component(session));
}

function branch(session: string, task: string): string {
  return `agent-graph/${component(session)}/${component(task)}`;
}

function statusPaths(worktree: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" });
  const entries = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") i++;
  }
  return paths;
}

export function prepareIntegration(repo: string, session: string, baseBranch: string): string {
  const path = join(root(repo, session), "integration");
  const name = branch(session, "integration");
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  if (git(repo, "branch", "--list", name)) git(repo, "worktree", "add", path, name);
  else git(repo, "worktree", "add", "-b", name, path, baseBranch);
  return path;
}

export function createTaskWorktree(repo: string, session: string, taskId: string): string {
  const integration = join(root(repo, session), "integration");
  if (!existsSync(integration)) throw new Error("Integration worktree is missing");
  const path = join(root(repo, session), component(taskId));
  const name = branch(session, taskId);
  if (existsSync(path)) return path;
  if (git(repo, "branch", "--list", name)) git(repo, "worktree", "add", path, name);
  else git(repo, "worktree", "add", "-b", name, path, branch(session, "integration"));
  return path;
}

export function commitScoped(worktree: string, message: string, patterns: string[]): string[] {
  const paths = statusPaths(worktree);
  const included = paths.filter((path) => patterns.some((pattern) => matchesGlob(path, pattern)));
  const excluded = paths.filter((path) => !included.includes(path));
  if (included.length) {
    git(worktree, "add", "-A", "--", ...included);
    git(worktree, "commit", "--only", "-m", message, "--", ...included);
  }
  return excluded;
}

export function mergeIntoIntegration(repo: string, session: string, taskId: string): { conflict: boolean; files: string[] } {
  const integration = join(root(repo, session), "integration");
  try {
    git(integration, "merge", "--no-ff", "--no-edit", branch(session, taskId));
    return { conflict: false, files: [] };
  } catch (error) {
    const files = git(integration, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (!files.length) throw error;
    git(integration, "merge", "--abort");
    return { conflict: true, files };
  }
}

export function removeTaskWorktree(repo: string, session: string, taskId: string): string | undefined {
  const path = join(root(repo, session), component(taskId));
  if (!existsSync(path)) return undefined;
  const remaining = statusPaths(path);
  let backup: string | undefined;
  if (remaining.length) {
    backup = `${path}-backup-${Date.now()}`;
    for (const file of remaining) {
      const source = join(path, file);
      if (!existsSync(source)) continue;
      const target = join(backup, file);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
    }
  }
  git(repo, "worktree", "remove", "--force", path);
  return backup;
}
