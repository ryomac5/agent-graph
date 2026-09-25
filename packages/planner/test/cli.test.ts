import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const cli = join(import.meta.dirname, "../src/cli.ts");
test("CLI run を別プロセスの status と approve で操作する", { timeout: 15_000 }, async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "planner-cli-"));
  const env = { ...process.env, XDG_STATE_HOME: join(repo, "state"), XDG_CACHE_HOME: join(repo, "cache") };
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "initial");
  writeFileSync(join(repo, "tasks.yaml"), "goal: cli\ntasks:\n  - id: gate\n    title: gate\n    executor: human\n");
  const args = ["--session", "cli", "--spec", "tasks.yaml"];
  const child = spawn(process.execPath, [cli, "run", ...args, "--no-pr"], { cwd: repo, env, stdio: "pipe" });
  t.after(() => child.kill());
  const exited = once(child, "exit");
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  let waiting = false;
  for (let i = 0; i < 50; i++) {
    await delay(50);
    try {
      const status = JSON.parse(execFileSync(process.execPath, [cli, "status", ...args], { cwd: repo, env, encoding: "utf8", stdio: "pipe" }));
      if (status.tasks[0].state === "waiting_human") { waiting = true; break; }
    } catch { /* run の初期登録前だけ再試行する */ }
  }
  assert.ok(waiting, stderr);
  execFileSync(process.execPath, [cli, "approve", "gate", ...args], { cwd: repo, env, stdio: "pipe" });
  assert.equal((await exited)[0], 0, stderr);
  assert.equal(JSON.parse(stdout).tasks[0].state, "done");
});
