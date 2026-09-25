import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSpec } from "../src/spec.ts";

const check = fileURLToPath(new URL("../../../scripts/e2e-stage6-check.ts", import.meta.url));

test("stage6 fixture の両形式でレビューに sonnet を指定する", { timeout: 10_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), "stage6-fixture-"));
  try {
    for (const kind of ["full", "compare"]) {
      execFileSync(process.execPath, [check, "fixture", repo, kind]);
      const spec = loadSpec(join(repo, ".agents/graph/stage6/tasks.yaml"));
      assert.deepEqual(spec.tasks.filter((task) => task.accept.length).map((task) => task.review_model),
        ["sonnet", "sonnet", "sonnet"]);
      assert.equal(spec.tasks.some((task) => task.executor === "pr"), kind === "full");
    }
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("旧版が途中で停止しても状態とファイルの両方の差分を表示する", { timeout: 10_000 }, () => {
  const repo = mkdtempSync(join(tmpdir(), "stage6-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try {
    git("init", "-b", "agent/stage6/integration");
    writeFileSync(join(repo, "unexpected.txt"), "legacy\n");
    git("add", "unexpected.txt");
    git("-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "commit", "-m", "fixture");
    mkdirSync(join(repo, ".agents/state/graph"), { recursive: true });
    writeFileSync(join(repo, ".agents/state/graph/stage6.json"), JSON.stringify({ a: { state: "waiting_human" } }));
    const expected = join(repo, "expected.json");
    writeFileSync(expected, JSON.stringify({ states: { a: "done", b: "done" }, files: ["a.txt"] }));
    for (const mode of ["compare", "diagnose"]) {
      const result = spawnSync(process.execPath, [check, mode, repo, expected], { encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, mode === "compare" ? 1 : 0, result.stderr);
      assert.match(result.stdout, /a: done \/ waiting_human/);
      assert.match(result.stdout, /b: done \/ \(missing\)/);
      assert.match(result.stdout, /- a\.txt/);
      assert.match(result.stdout, /\+ unexpected\.txt/);
    }
    git("branch", "-m", "main");
    const output = execFileSync(process.execPath, [check, "diagnose", repo, expected], { encoding: "utf8" });
    assert.match(output, /branch missing/);
    assert.match(output, /- a\.txt/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
