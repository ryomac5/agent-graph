import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { commitScoped, createTaskWorktree, mergeIntoIntegration, prepareIntegration, removeTaskWorktree } from "../src/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("worktree の作成、限定コミット、マージ、衝突、退避", () => {
  const repo = mkdtempSync(join(tmpdir(), "planner-repo-"));
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "planner-cache-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "in.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const integration = prepareIntegration(repo, "s1", "main");
  assert.equal(prepareIntegration(repo, "s1", "main"), integration);
  const task = createTaskWorktree(repo, "s1", "t1");
  writeFileSync(join(task, "in.txt"), "task\n");
  writeFileSync(join(task, "outside.txt"), "outside\n");
  assert.deepEqual(commitScoped(task, "scoped", ["in.txt"]), ["outside.txt"]);
  assert.equal(git(task, "show", "--format=", "--name-only", "HEAD"), "in.txt");
  assert.deepEqual(mergeIntoIntegration(repo, "s1", "t1"), { conflict: false, files: [] });
  assert.equal(readFileSync(join(integration, "in.txt"), "utf8"), "task\n");
  const wrapper = mkdtempSync(join(tmpdir(), "planner-git-"));
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const script = join(wrapper, "git");
  writeFileSync(script, `#!/bin/sh\nif [ "$1" = stash ]; then exit 1; fi\nexec "${realGit}" "$@"\n`);
  chmodSync(script, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${wrapper}:${originalPath ?? ""}`;
  let backup: string | undefined;
  try {
    backup = removeTaskWorktree(repo, "s1", "t1");
  } finally {
    process.env.PATH = originalPath;
  }
  assert.ok(backup && existsSync(join(backup, "outside.txt")));
  assert.equal(existsSync(task), false);
  const second = createTaskWorktree(repo, "s1", "t2");
  writeFileSync(join(second, "in.txt"), "second\n");
  commitScoped(second, "second", ["in.txt"]);
  writeFileSync(join(integration, "in.txt"), "integration\n");
  commitScoped(integration, "integration", ["in.txt"]);
  assert.deepEqual(mergeIntoIntegration(repo, "s1", "t2"), { conflict: true, files: ["in.txt"] });
  assert.equal(git(integration, "status", "--porcelain"), "");
});

test("session と taskId が同じでも統合ブランチから作成する", () => {
  const repo = mkdtempSync(join(tmpdir(), "planner-repo-"));
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "planner-cache-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "in.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const integration = prepareIntegration(repo, "same", "main");
  writeFileSync(join(integration, "in.txt"), "integration\n");
  commitScoped(integration, "integration", ["in.txt"]);
  const task = createTaskWorktree(repo, "same", "same");
  assert.equal(readFileSync(join(task, "in.txt"), "utf8"), "integration\n");
});

test("glob のブレースと文字クラスを scope に使用できる", () => {
  const repo = mkdtempSync(join(tmpdir(), "planner-repo-"));
  process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "planner-cache-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "initial.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  prepareIntegration(repo, "glob", "main");
  const task = createTaskWorktree(repo, "glob", "task");
  writeFileSync(join(task, "a.ts"), "a\n");
  writeFileSync(join(task, "b.js"), "b\n");
  writeFileSync(join(task, "c.txt"), "c\n");
  assert.deepEqual(commitScoped(task, "glob", ["{a,b}.[jt]s"]), ["c.txt"]);
  assert.deepEqual(git(task, "show", "--format=", "--name-only", "HEAD").split("\n"), ["a.ts", "b.js"]);
});
