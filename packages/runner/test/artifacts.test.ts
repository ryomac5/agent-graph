import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openLedger } from "../../core/src/ledger/ledger.ts";
import type { FactInput } from "../../core/src/ledger/facts.ts";
import { rebuild } from "../../core/src/ledger/rebuild.ts";
import { projectArtifacts } from "../../core/src/ledger/projections/artifacts.ts";
import { projectRuns } from "../../core/src/ledger/projections/runs.ts";
import { finalizeArtifacts, recordCommitResult, type CommitResult } from "../src/artifacts/index.ts";
import { recordWorktree } from "../src/worktree.ts";
import { FakeHost } from "../src/host/contract.ts";
import { Supervisor } from "../src/supervisor.ts";

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function createFixture(t: TestContext, customPatterns: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "artifacts-test-"));
  const repo = join(directory, "repo");
  const blobs = join(directory, "blobs");
  mkdirSync(repo);
  runGit(repo, "init", "-b", "main");
  runGit(repo, "config", "user.email", "test@example.invalid");
  runGit(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "base\n");
  runGit(repo, "add", "."); runGit(repo, "commit", "-m", "base");
  const rules = { patterns: customPatterns };
  const ledgerPath = join(directory, "ledger.db");
  const ledger = openLedger(ledgerPath, { storageScope: "full_diff", redactionRules: rules });
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  t.after(() => {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
    ledger.close(); rmSync(directory, { recursive: true, force: true });
  });
  let counter = 0;
  function request(runId: string) {
    const id = ++counter;
    return { runId, provider: "codex" as const, sourceEventId: `event:${id}`,
      sourceTs: new Date(Date.UTC(2030, 0, 1, 0, 0, id)).toISOString() };
  }
  function start(runId: string, isolation: "shared" | "worktree" = "shared") {
    const stamp = request(runId);
    ledger.append({ source: "host-codex", source_event_id: stamp.sourceEventId, source_ts: stamp.sourceTs,
      kind: "run.created", subject: `run:${runId}`, confidence: "confirmed",
      payload: { conversation_id: runId, generation: 1, state: "running" } });
    const treeStamp = request(runId);
    return recordWorktree(ledger, { runId, generation: 1, provider: "codex", cwd: repo, isolation,
      sourceEventId: treeStamp.sourceEventId, sourceTs: treeStamp.sourceTs });
  }
  function capture(runId: string, verification?: { passed: boolean }) {
    return finalizeArtifacts(ledger, { ...request(runId), ...(verification ? { verification } : {}) },
      { blobDirectory: blobs, redactionRules: rules })!;
  }
  function commit(cwd: string, body: string, ...args: string[]) {
    writeFileSync(join(cwd, "tracked.txt"), body);
    runGit(cwd, "add", "."); runGit(cwd, "commit", "-m", "change", ...args);
    return runGit(cwd, "rev-parse", "HEAD");
  }
  function result(runId: string, value: CommitResult) { recordCommitResult(ledger, request(runId), value); }
  function readPatch(hash: string) { return readFileSync(join(blobs, hash), "utf8"); }
  return { repo, ledger, ledgerPath, blobs, start, capture, commit, result, readPatch };
}

test("dedicated execution fixes HEAD, range, staged, unstaged and untracked changes without Git writes", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("isolated", "worktree");
  const head = fixture.commit(tree.cwd, "committed\n");
  writeFileSync(join(tree.cwd, "staged.txt"), "staged\n");
  runGit(tree.cwd, "add", "staged.txt");
  writeFileSync(join(tree.cwd, "tracked.txt"), "unstaged\n");
  writeFileSync(join(tree.cwd, "new\nfile.txt"), "untracked\n");
  writeFileSync(join(tree.cwd, "empty.txt"), "");
  const index = readFileSync(runGit(tree.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index"));
  const status = runGit(tree.cwd, "status", "--porcelain=v1");
  const count = runGit(tree.cwd, "rev-list", "--all", "--count");
  const artifact = fixture.capture("isolated", { passed: true });
  assert.equal(artifact.head_sha, head);
  assert.equal(artifact.base_sha, tree.base_sha);
  assert.equal(artifact.repository_id, tree.repository_id);
  assert.equal(artifact.worktree_id, tree.worktree_id);
  assert.deepEqual(artifact.commits, [head]);
  assert.deepEqual(artifact.untracked, ["empty.txt", "new\nfile.txt"]);
  assert.deepEqual(artifact.verification, { passed: true });
  assert.equal(artifact.attribution, "confirmed");
  const patch = fixture.readPatch(artifact.patch_hash);
  for (const value of ["+unstaged", "+staged", "+untracked", "empty.txt"]) assert.ok(patch.includes(value), value);
  assert.equal(artifact.patch_hash, createHash("sha256").update(patch).digest("hex"));
  assert.equal(runGit(tree.cwd, "status", "--porcelain=v1"), status);
  assert.equal(runGit(tree.cwd, "rev-list", "--all", "--count"), count);
  assert.deepEqual(readFileSync(runGit(tree.cwd, "rev-parse", "--path-format=absolute", "--git-path", "index")), index);
  const before = fixture.ledger.readSince(0, 1000).length;
  assert.equal(fixture.capture("isolated").id, artifact.id);
  assert.equal(fixture.ledger.readSince(0, 1000).length, before);
  writeFileSync(join(tree.cwd, "new\nfile.txt"), "more\n");
  const next = fixture.capture("isolated");
  assert.equal(next.version, 2);
  assert.equal(next.previous_artifact_id, artifact.id);
  assert.notEqual(next.patch_hash, artifact.patch_hash);
  rmSync(tree.cwd, { recursive: true, force: true });
  assert.equal(fixture.readPatch(artifact.patch_hash), patch);
});

test("amend creates a new version and retains its original SHA, including unchanged patches", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("amend", "worktree");
  const original = fixture.commit(tree.cwd, "committed\n");
  const first = fixture.capture("amend");
  runGit(tree.cwd, "commit", "--amend", "-m", "new message");
  const head = runGit(tree.cwd, "rev-parse", "HEAD");
  assert.notEqual(head, original);
  const amended = fixture.capture("amend");
  assert.equal(amended.version, 2);
  assert.equal(amended.patch_hash, first.patch_hash);
  assert.deepEqual(amended.commits, [head]);
  assert.deepEqual(amended.commit_relations, [{ kind: "amend", original_sha: original, head_sha: head }]);
  assert.equal(fixture.capture("amend").version, 2);
});

test("cherry-pick records the successful result SHA and original commit relation", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("pick", "worktree");
  runGit(fixture.repo, "checkout", "-b", "source");
  const original = fixture.commit(fixture.repo, "picked\n");
  runGit(tree.cwd, "commit", "--allow-empty", "-m", "independent");
  fixture.capture("pick");
  runGit(tree.cwd, "cherry-pick", original);
  const head = runGit(tree.cwd, "rev-parse", "HEAD");
  assert.notEqual(head, original);
  const picked = fixture.capture("pick");
  assert.equal(picked.version, 2);
  assert.equal(picked.attribution, "confirmed");
  assert.deepEqual(picked.commit_relations, [{ kind: "cherry-pick", original_sha: original, head_sha: head }]);
});

test("shared successful commit requires a unique SHA match and remains inferred", (t) => {
  const fixture = createFixture(t);
  fixture.start("single");
  const head = fixture.commit(fixture.repo, "committed\n");
  assert.equal(fixture.capture("single").attribution, "unknown");
  fixture.result("single", { success: true, head_sha: "wrong" });
  assert.equal(fixture.capture("single").attribution, "unknown");
  fixture.result("single", { success: true, head_sha: head });
  assert.equal(fixture.capture("single").attribution, "inferred");
});

test("shared simultaneous editing is joint for both runs, regardless of successful commit result", (t) => {
  const fixture = createFixture(t);
  fixture.start("a"); fixture.start("b");
  writeFileSync(join(fixture.repo, "b.txt"), "b edit\n");
  const head = fixture.commit(fixture.repo, "a edit\n");
  fixture.result("a", { success: true, head_sha: head });
  for (const run of ["a", "b"]) {
    const artifact = fixture.capture(run);
    assert.equal(artifact.attribution, "joint");
    assert.ok(fixture.readPatch(artifact.patch_hash).includes("+b edit"));
  }
});

test("failed commit and help do not provide attribution, even with a matching SHA", (t) => {
  const fixture = createFixture(t);
  fixture.start("failed");
  const head = fixture.commit(fixture.repo, "external change\n");
  const failed = spawnSync("git", ["commit", "-m", "nothing"], { cwd: fixture.repo });
  assert.notEqual(failed.status, 0);
  fixture.result("failed", { success: false, head_sha: head });
  assert.equal(fixture.capture("failed").attribution, "unknown");
  fixture.result("failed", { success: true, help: true, head_sha: head });
  assert.equal(fixture.capture("failed").attribution, "unknown");
});

test("blob contents use ledger redaction including custom rules before hashing or writing", (t) => {
  const fixture = createFixture(t, ["private-custom-value"]);
  fixture.start("secret");
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
  writeFileSync(join(fixture.repo, "tracked.txt"), `${secret}\nAPI_TOKEN=small-secret\nprivate-custom-value\n`);
  writeFileSync(join(fixture.repo, ".env"), "PASSWORD=another-secret\n");
  const artifact = fixture.capture("secret");
  const patch = fixture.readPatch(artifact.patch_hash);
  for (const value of [secret, "small-secret", "another-secret", "private-custom-value"]) {
    assert.ok(!patch.includes(value));
    assert.ok(!JSON.stringify(fixture.ledger.readSince(0, 1000)).includes(value));
  }
  assert.ok(patch.includes("[REDACTED:"));
  assert.equal(artifact.patch_hash, createHash("sha256").update(patch).digest("hex"));
});

test("supervisor captures changes during execution and at exit, publishing artifact sequences", async (t) => {
  const fixture = createFixture(t);
  const host = new FakeHost("codex");
  const seqs: number[] = [];
  const supervisor = new Supervisor(fixture.ledger, (event) => { if ("seq" in event) seqs.push(event.seq); },
    { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
  supervisor.registerHost(host);
  await supervisor.start("codex", { runId: "managed", conversationId: "managed", generation: 1,
    cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
  writeFileSync(join(fixture.repo, "tracked.txt"), "first\n");
  host.emit("managed", { type: "state", state: "idle" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const first = projectArtifacts(fixture.ledger.readSince(0, 1000));
  assert.equal(first.length, 1);
  writeFileSync(join(fixture.repo, "tracked.txt"), "second\n");
  host.emit("managed", { type: "exit", exitCode: 0 });
  await supervisor.wait("managed");
  const facts = fixture.ledger.readSince(0, 1000);
  assert.equal(projectArtifacts(facts).length, 2);
  for (const fact of facts.filter((fact) => fact.kind === "artifact.version_created")) assert.ok(seqs.includes(fact.seq));
});

test("dedicated uncommitted changes are captured without claiming commit attribution", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("uncommitted", "worktree");
  writeFileSync(join(tree.cwd, "tracked.txt"), "edited\n");
  const artifact = fixture.capture("uncommitted");
  assert.deepEqual(artifact.commits, []);
  assert.equal(artifact.attribution, "unknown");
  assert.ok(fixture.readPatch(artifact.patch_hash).includes("+edited"));
});

test("blob publication replaces incomplete content atomically and cleans temporary files on rename failure", (t) => {
  const fixture = createFixture(t);
  fixture.start("atomic");
  writeFileSync(join(fixture.repo, "tracked.txt"), "changed\n");
  const patch = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color",
    "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--"], { cwd: fixture.repo, encoding: "utf8" });
  const hash = createHash("sha256").update(patch).digest("hex");
  mkdirSync(fixture.blobs);
  const blob = join(fixture.blobs, hash);
  mkdirSync(blob);
  writeFileSync(join(blob, "blocker"), "occupied");
  assert.throws(() => fixture.capture("atomic"));
  assert.deepEqual(readdirSync(fixture.blobs), [hash]);
  assert.equal(projectArtifacts(fixture.ledger.readSince(0, 1000)).length, 0);
  rmSync(blob, { recursive: true });
  writeFileSync(blob, patch.slice(0, 10));
  const artifact = fixture.capture("atomic");
  assert.equal(artifact.patch_hash, hash);
  assert.equal(fixture.readPatch(hash), patch);
  assert.equal(statSync(blob).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(fixture.blobs), [hash]);
});

for (const exitCode of [0, 1]) {
  test(`artifact storage failure preserves host exit ${exitCode} and wait resolves`, async (t) => {
    const fixture = createFixture(t);
    const host = new FakeHost("codex");
    const published: number[] = [];
    writeFileSync(fixture.blobs, "not a directory");
    const supervisor = new Supervisor(fixture.ledger, (event) => { if ("seq" in event) published.push(event.seq); },
      { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
    supervisor.registerHost(host);
    await supervisor.start("codex", { runId: "storage", conversationId: "storage", generation: 1,
      cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
    writeFileSync(join(fixture.repo, "tracked.txt"), "change\n");
    host.emit("storage", { type: "exit", exitCode });
    await supervisor.wait("storage");
    const facts = fixture.ledger.readSince(0, 1000);
    assert.equal(projectRuns(facts)[0].state, exitCode === 0 ? "ended" : "failed");
    assert.ok(!facts.some((fact) => fact.kind === "run.state_changed" && fact.payload?.state === "unknown"));
    const failure = facts.find((fact) => fact.payload && "artifact_capture" in fact.payload)!;
    assert.ok(failure);
    assert.equal((failure.payload as unknown as { artifact_capture: { status: string } }).artifact_capture.status, "failed");
    assert.ok(published.includes(failure.seq));
    assert.equal(projectArtifacts(facts).length, 0);
    assert.equal(supervisor.isOpen("storage"), false);
  });
}

test("fact capture failure does not stop later host events or retry at exit; unrelated facts skip capture", async (t) => {
  const fixture = createFixture(t);
  const host = new FakeHost("codex");
  writeFileSync(fixture.blobs, "not a directory");
  const supervisor = new Supervisor(fixture.ledger, () => {},
    { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
  supervisor.registerHost(host);
  await supervisor.start("codex", { runId: "retry", conversationId: "retry", generation: 1,
    cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
  writeFileSync(join(fixture.repo, "tracked.txt"), "first\n");
  host.emit("retry", { type: "fact", fact: { source_event_id: "message", source_ts: new Date().toISOString(),
    kind: "message.created", subject: "message:unrelated", confidence: "confirmed", payload: {
      provider: "codex", native_id: "unrelated", version: 1, role: "assistant", body: "commentary", body_state: "stored" } } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!fixture.ledger.readSince(0, 1000).some((fact) => fact.payload && "artifact_capture" in fact.payload));
  host.emit("retry", { type: "fact", fact: { source_event_id: "tool", source_ts: new Date().toISOString(),
    kind: "message.created", subject: "message:tool", confidence: "confirmed", payload: {
      provider: "codex", native_id: "tool", version: 1, role: "tool", tool_output: "written", body_state: "stored" } } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.ledger.readSince(0, 1000).filter((fact) => fact.payload && "artifact_capture" in fact.payload).length, 1);
  rmSync(fixture.blobs);
  writeFileSync(join(fixture.repo, "tracked.txt"), "second\n");
  host.emit("retry", { type: "state", state: "running" });
  host.emit("retry", { type: "exit", exitCode: 0 });
  await supervisor.wait("retry");
  const facts = fixture.ledger.readSince(0, 1000);
  assert.equal(projectRuns(facts)[0].state, "ended");
  assert.equal(projectArtifacts(facts).length, 1);
  assert.ok(fixture.readPatch(projectArtifacts(facts)[0].patch_hash!).includes("+second"));
});

test("garbage-collected previous HEAD still permits a new artifact version", async (t) => {
  const fixture = createFixture(t);
  const host = new FakeHost("codex");
  const supervisor = new Supervisor(fixture.ledger, () => {},
    { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
  supervisor.registerHost(host);
  await supervisor.start("codex", { runId: "gc", conversationId: "gc", generation: 1,
    cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
  const original = fixture.commit(fixture.repo, "original\n");
  host.emit("gc", { type: "state", state: "idle" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(projectArtifacts(fixture.ledger.readSince(0, 1000)).length, 1);
  runGit(fixture.repo, "commit", "--amend", "-m", "replacement");
  runGit(fixture.repo, "reflog", "expire", "--expire=now", "--all");
  runGit(fixture.repo, "prune", "--expire=now");
  assert.notEqual(spawnSync("git", ["cat-file", "-e", original], { cwd: fixture.repo }).status, 0);
  host.emit("gc", { type: "exit", exitCode: 0 });
  await supervisor.wait("gc");
  const facts = fixture.ledger.readSince(0, 1000);
  assert.equal(projectRuns(facts)[0].state, "ended");
  assert.ok(!facts.some((fact) => fact.payload && "artifact_capture" in fact.payload));
  const artifacts = projectArtifacts(facts);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[1].version, 2);
  assert.equal(artifacts[1].head_sha, runGit(fixture.repo, "rev-parse", "HEAD"));
});

test("S8: replay, shuffled input and rebuilding preserve simultaneous commits, failure, amend and untracked diff", (t) => {
  const fixture = createFixture(t);
  const input = JSON.parse(readFileSync(new URL("./samples/S8/input.json", import.meta.url), "utf8"));
  const expected = JSON.parse(readFileSync(new URL("./samples/S8/expected-projection.json", import.meta.url), "utf8"));
  const expectedLedger = JSON.parse(readFileSync(new URL("./samples/S8/expected-ledger.json", import.meta.url), "utf8"));
  const trees = new Map<string, string>();
  for (const action of input) {
    if (action.type === "start") trees.set(action.run, fixture.start(action.run, action.isolation).cwd);
    if (action.type === "write") writeFileSync(join(trees.get(action.run)!, action.file), action.content);
    if (action.type === "commit") {
      const cwd = trees.get(action.run)!;
      runGit(cwd, "add", "."); runGit(cwd, "commit", "-m", "sample", ...(action.amend ? ["--amend"] : []));
      fixture.result(action.run, { success: true, head_sha: runGit(cwd, "rev-parse", "HEAD") });
    }
    if (action.type === "failed-commit") {
      const cwd = trees.get(action.run)!;
      assert.notEqual(spawnSync("git", ["commit", "-m", "empty"], { cwd }).status, 0);
      fixture.result(action.run, { success: false, head_sha: runGit(cwd, "rev-parse", "HEAD") });
    }
    if (action.type === "capture") fixture.capture(action.run);
  }
  const facts = fixture.ledger.readSince(0, 1000);
  const artifacts = projectArtifacts(facts);
  assert.deepEqual(artifacts.map((artifact) => ({ run_id: artifact.run_id, version: artifact.version,
    attribution: artifact.attribution, untracked: artifact.untracked })), expected);
  assert.deepEqual(facts.filter((fact) => fact.kind === "artifact.version_created")
    .map((fact) => ({ kind: fact.kind, run_id: fact.payload!.run_id, version: fact.payload!.version })), expectedLedger);
  for (const fact of facts) {
    const { cursor, supersedes, ...input } = fact;
    assert.equal(fixture.ledger.append({ ...input, ...(cursor ? { cursor } : {}),
      ...(supersedes ? { supersedes } : {}) } as FactInput).status, "duplicate");
  }
  assert.equal(fixture.ledger.readSince(0, 1000).length, facts.length);
  assert.deepEqual(projectArtifacts([...facts].reverse()), artifacts);
  for (let offset = 1; offset < facts.length; offset += 1) {
    assert.deepEqual(projectArtifacts([...facts.slice(offset), ...facts.slice(0, offset)]), artifacts);
  }
  assert.deepEqual(projectArtifacts(fixture.ledger.readSince(0, 1000)), artifacts);
  const database = new DatabaseSync(fixture.ledgerPath);
  try {
    rebuild(database);
    const rows = database.prepare("SELECT run_id, version, attribution, untracked FROM artifacts ORDER BY run_id, version").all();
    assert.deepEqual(rows.map((row) => ({ ...row, untracked: JSON.parse(String(row.untracked)) })), expected);
    rebuild(database);
    assert.deepEqual(database.prepare("SELECT run_id, version, attribution, untracked FROM artifacts ORDER BY run_id, version").all(), rows);
  } finally { database.close(); }
  const amended = artifacts.find((artifact) => artifact.run_id === "dedicated" && artifact.version === 2)!;
  assert.equal((amended as unknown as { commit_relations: unknown[] }).commit_relations.length, 1);
  const shared = artifacts.find((artifact) => artifact.run_id === "shared-a" && artifact.version === 2)!;
  assert.ok(fixture.readPatch(shared.patch_hash!).includes("+new file"));
});

test("binary changes retain redacted content and produce a new hash when their bytes change", (t) => {
  const fixture = createFixture(t);
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";
  writeFileSync(join(fixture.repo, "binary.dat"), Buffer.from(`\0base\n${secret}`));
  runGit(fixture.repo, "add", "."); runGit(fixture.repo, "commit", "-m", "binary base");
  fixture.start("binary");
  writeFileSync(join(fixture.repo, "binary.dat"), Buffer.from(`\0next\n${secret}`));
  writeFileSync(join(fixture.repo, "new.dat"), Buffer.from(`\0new\n${secret}`));
  const first = fixture.capture("binary");
  const patch = fixture.readPatch(first.patch_hash);
  const contents = patch.split("\n").filter((line) => line.startsWith("agent-graph-binary "))
    .map((line) => JSON.parse(line.slice("agent-graph-binary ".length)));
  assert.equal(contents.length, 2);
  for (const content of contents) {
    for (const side of [content.old, content.new].filter(Boolean)) {
      const decoded = Buffer.from(side, "base64").toString("utf8");
      assert.ok(!decoded.includes(secret));
      assert.ok(decoded.includes("[REDACTED:"));
    }
  }
  writeFileSync(join(fixture.repo, "new.dat"), Buffer.from(`\0later\n${secret}`));
  const next = fixture.capture("binary");
  assert.equal(next.version, 2);
  assert.notEqual(next.patch_hash, first.patch_hash);
});

test("observed conversations remain unknown even in a dedicated tree with a successful commit SHA", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("outside", "worktree");
  fixture.ledger.append({ source: "rollout-codex", source_event_id: "outside-conversation", source_ts: "2029-01-01T00:00:00Z",
    kind: "conversation.created", subject: "conversation:outside", confidence: "confirmed",
    payload: { provider: "codex", native_id: "outside", origin: "observed", type: "interactive", history_format: "jsonl" } });
  const head = fixture.commit(tree.cwd, "outside change\n");
  fixture.result("outside", { success: true, head_sha: head });
  assert.equal(fixture.capture("outside").attribution, "unknown");
});
