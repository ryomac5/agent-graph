import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAcceptance } from "../src/accept/run.ts";

function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "agent-graph-accept-"));
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, "allowed.txt"), "before");
  execFileSync("git", ["-C", cwd, "add", "allowed.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
  return cwd;
}

test("合格したコマンドを記録する", async () => {
  const result = await runAcceptance({ commands: ["printf 'ok'"], cwd: makeRepo(), scope: ["allowed.txt"], baseRef: "HEAD" });
  assert.equal(result.passed, true);
  assert.deepEqual(result.scopeViolations, []);
  assert.equal(result.results[0].output, "ok");
  assert.equal(result.results[0].exitCode, 0);
  assert.ok(result.results[0].durationMs >= 0);
});

test("失敗したコマンドと末尾出力を記録する", async () => {
  const result = await runAcceptance({ commands: ["printf x; exit 7", "printf y"], cwd: makeRepo() });
  assert.equal(result.passed, false);
  assert.deepEqual(result.results.map((item) => item.exitCode), [7, 0]);
  assert.deepEqual(result.results.map((item) => item.output), ["x", "y"]);
});

test("タイムアウトでプロセスグループを止める", async () => {
  const result = await runAcceptance({ commands: ["sleep 10"], cwd: makeRepo(), timeoutMs: 30 });
  assert.equal(result.passed, false);
  assert.equal(result.results[0].exitCode, 124);
});

test("作業ツリーと baseRef の scope 違反を検出する", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "outside.txt"), "outside");
  const result = await runAcceptance({ commands: ["true"], cwd, scope: ["allowed.txt"], baseRef: "HEAD" });
  assert.equal(result.passed, false);
  assert.deepEqual(result.scopeViolations, ["outside.txt"]);
});

test("作業ツリーが清潔でも baseRef 以降の変更を検出する", async () => {
  const cwd = makeRepo();
  writeFileSync(join(cwd, "outside space.txt"), "outside");
  execFileSync("git", ["-C", cwd, "add", "outside space.txt"]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "second"]);
  const result = await runAcceptance({ commands: ["true"], cwd, scope: ["allowed.txt"], baseRef: "HEAD~1" });
  assert.deepEqual(result.scopeViolations, ["outside space.txt"]);
});
