import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openLedger } from "../../core/src/ledger/index.ts";
import { projectEntityRecords } from "../../core/src/ledger/projections/delegations.ts";
import { inspectWorktree, recordWorktree, type WorktreeRecord } from "../src/worktree.ts";

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function createFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "worktree-test-"));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  runGit(repo, "init", "-b", "main");
  runGit(repo, "config", "user.email", "test@example.invalid");
  runGit(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  runGit(repo, "add", "."); runGit(repo, "commit", "-m", "base");
  const ledger = openLedger(join(directory, "ledger.db"));
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  t.after(() => {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCache;
    ledger.close(); rmSync(directory, { recursive: true, force: true });
  });
  function start(runId: string) {
    ledger.append({ source: "host-codex", source_event_id: `create:${runId}`, source_ts: "2026-01-01T00:00:00Z",
      kind: "run.created", subject: `run:${runId}`, confidence: "confirmed",
      payload: { conversation_id: runId, generation: 1, state: "running" } });
    return recordWorktree(ledger, { runId, generation: 1, provider: "codex", cwd: repo,
      isolation: "shared", sourceEventId: `worktree:${runId}`, sourceTs: "2026-01-01T00:00:01Z" });
  }
  return { directory, repo, ledger, start };
}

test("records canonical repository and worktree identities, HEAD and dirty listing hash", (t) => {
  const { directory, repo, ledger, start } = createFixture(t);
  const clean = inspectWorktree(repo);
  assert.equal(clean.repository_id, createHash("sha256").update(realpathSync(join(repo, ".git"))).digest("hex"));
  assert.equal(clean.base_sha, runGit(repo, "rev-parse", "HEAD"));
  assert.equal(clean.dirty_state, createHash("sha256").update("").digest("hex"));
  assert.equal(clean.branch, runGit(repo, "rev-parse", "--abbrev-ref", "HEAD"));
  const alias = join(directory, "alias"); symlinkSync(repo, alias);
  mkdirSync(join(repo, "sub"));
  assert.deepEqual(inspectWorktree(alias), clean);
  assert.deepEqual(inspectWorktree(join(repo, "sub")), clean);
  writeFileSync(join(repo, "tracked.txt"), "modified\n");
  writeFileSync(join(repo, "new\nfile.txt"), "untracked\n");
  const record = start("first");
  assert.notEqual(record.dirty_state, clean.dirty_state);
  assert.equal(record.dirty_state, createHash("sha256").update(execFileSync("git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo })).digest("hex"));
  assert.deepEqual(inspectWorktree(repo).dirty_state, record.dirty_state);
  const saved = projectEntityRecords<WorktreeRecord>(ledger.readSince(0, 100), "run")[0];
  for (const field of ["repository_id", "worktree_id", "branch", "base_sha", "dirty_state"] as const) assert.equal(saved[field], record[field]);
  const before = ledger.readSince(0, 100).length;
  writeFileSync(join(repo, "other.txt"), "later");
  assert.deepEqual(recordWorktree(ledger, { runId: "first", generation: 1, provider: "codex", cwd: repo,
    isolation: "shared", sourceEventId: "worktree:first", sourceTs: "2026-01-01T00:00:01Z" }), record);
  assert.equal(ledger.readSince(0, 100).length, before);
});

test("worktree identity stays stable across commits and changes with HEAD reference", (t) => {
  const { repo } = createFixture(t);
  const before = inspectWorktree(repo);
  writeFileSync(join(repo, "tracked.txt"), "commit\n");
  runGit(repo, "add", "."); runGit(repo, "commit", "-m", "next");
  const after = inspectWorktree(repo);
  assert.equal(after.worktree_id, before.worktree_id);
  assert.notEqual(after.base_sha, before.base_sha);
  runGit(repo, "checkout", "--detach");
  assert.notEqual(inspectWorktree(repo).worktree_id, after.worktree_id);
  assert.equal(inspectWorktree(repo).branch, undefined);
});

test("shared simultaneous runs mark all peers joint and ignore terminal peers", (t) => {
  const { ledger, start } = createFixture(t);
  assert.equal(start("a").attribution, "confirmed");
  assert.deepEqual(start("b").joint_run_ids, ["a", "b"]);
  assert.deepEqual(start("c").joint_run_ids, ["a", "b", "c"]);
  const records = projectEntityRecords<WorktreeRecord>(ledger.readSince(0, 100), "run");
  for (const record of records) {
    assert.equal(record.attribution, "joint");
    assert.deepEqual(record.joint_run_ids, ["a", "b", "c"]);
    ledger.append({ source: "host-codex", source_event_id: `exit:${record.id}`, source_ts: "2026-01-01T00:00:02Z",
      kind: "run.state_changed", subject: `run:${record.id}`, confidence: "confirmed",
      payload: { state: "ended", generation: 1, end_evidence: { kind: "host_exit", exit_code: 0 } } });
  }
  assert.equal(start("d").attribution, "confirmed");
});

test("dedicated worktrees use planner isolation and keep the source dirty files untouched", (t) => {
  const { repo, ledger, start } = createFixture(t);
  writeFileSync(join(repo, "tracked.txt"), "source dirty\n");
  const records = ["isolated-a", "isolated-b"].map((runId) => {
    ledger.append({ source: "host-codex", source_event_id: `create:${runId}`, source_ts: "2026-01-01T00:00:00Z",
      kind: "run.created", subject: `run:${runId}`, confidence: "confirmed",
      payload: { conversation_id: runId, generation: 1, state: "running" } });
    return recordWorktree(ledger, { runId, generation: 1, provider: "codex", cwd: repo,
      isolation: "worktree", sourceEventId: `tree:${runId}`, sourceTs: "2026-01-01T00:00:01Z" });
  });
  assert.notEqual(records[0].cwd, records[1].cwd);
  assert.notEqual(records[0].worktree_id, records[1].worktree_id);
  for (const record of records) {
    assert.equal(record.repository_id, inspectWorktree(repo).repository_id);
    assert.equal(record.base_sha, runGit(repo, "rev-parse", "HEAD"));
    assert.equal(record.dirty_state, createHash("sha256").update("").digest("hex"));
    assert.equal(record.attribution, "confirmed");
    assert.notEqual(record.cwd, realpathSync(repo));
  }
  assert.equal(start("shared").attribution, "confirmed");
});

test("dirty listing distinguishes staged rename, deletion and untracked changes", (t) => {
  const { repo } = createFixture(t);
  const hashes = new Set([inspectWorktree(repo).dirty_state]);
  runGit(repo, "mv", "tracked.txt", "renamed\nfile.txt");
  hashes.add(inspectWorktree(repo).dirty_state);
  rmSync(join(repo, "renamed\nfile.txt"));
  hashes.add(inspectWorktree(repo).dirty_state);
  writeFileSync(join(repo, "untracked.txt"), "new");
  hashes.add(inspectWorktree(repo).dirty_state);
  assert.equal(hashes.size, 4);
});
