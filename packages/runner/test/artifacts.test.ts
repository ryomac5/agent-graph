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
import { finalizeArtifacts, finalizeArtifactsAsync, recordCommitResult, type CommitResult } from "../src/artifacts/index.ts";
import { recordWorktree } from "../src/worktree.ts";
import { FakeHost } from "../src/host/contract.ts";
import { Supervisor } from "../src/supervisor.ts";

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for artifact capture");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
      { blobDirectory: blobs })!;
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

test("amend with an unchanged patch retains the same version", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("amend", "worktree");
  const original = fixture.commit(tree.cwd, "committed\n");
  const first = fixture.capture("amend");
  runGit(tree.cwd, "commit", "--amend", "-m", "new message");
  const head = runGit(tree.cwd, "rev-parse", "HEAD");
  assert.notEqual(head, original);
  const amended = fixture.capture("amend");
  assert.equal(amended.version, 1);
  assert.equal(amended.patch_hash, first.patch_hash);
  assert.equal(amended.id, first.id);
  assert.deepEqual(amended.commits, [head]);
  assert.deepEqual(amended.commit_relations, [{ kind: "amend", original_sha: original, head_sha: head }]);
  assert.equal(fixture.capture("amend").version, 1);
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
  await waitUntil(() => projectArtifacts(fixture.ledger.readSince(0, 1000)).length === 1);
  const first = projectArtifacts(fixture.ledger.readSince(0, 1000));
  assert.equal(first.length, 1);
  writeFileSync(join(fixture.repo, "tracked.txt"), "second\n");
  host.emit("managed", { type: "exit", exitCode: 0 });
  await supervisor.wait("managed");
  const facts = fixture.ledger.readSince(0, 1000);
  assert.equal(projectArtifacts(facts).length, 2);
  for (const fact of facts.filter((fact) => fact.kind === "artifact.version_created")) assert.ok(seqs.includes(fact.seq));
});

test("dedicated uncommitted and untracked changes have confirmed attribution", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("uncommitted", "worktree");
  writeFileSync(join(tree.cwd, "tracked.txt"), "edited\n");
  writeFileSync(join(tree.cwd, "new.txt"), "new\n");
  const artifact = fixture.capture("uncommitted");
  assert.deepEqual(artifact.commits, []);
  assert.equal(artifact.attribution, "confirmed");
  assert.deepEqual(artifact.file_attribution, [{ file: "new.txt", attribution: "confirmed" }, { file: "tracked.txt", attribution: "confirmed" }]);
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
  await waitUntil(() => fixture.ledger.readSince(0, 1000).some((fact) => fact.payload && "artifact_capture" in fact.payload));
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

test("garbage-collected previous HEAD still permits artifact recapture", async (t) => {
  const fixture = createFixture(t);
  const host = new FakeHost("codex");
  const supervisor = new Supervisor(fixture.ledger, () => {},
    { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
  supervisor.registerHost(host);
  await supervisor.start("codex", { runId: "gc", conversationId: "gc", generation: 1,
    cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
  const original = fixture.commit(fixture.repo, "original\n");
  host.emit("gc", { type: "state", state: "idle" });
  await waitUntil(() => projectArtifacts(fixture.ledger.readSince(0, 1000)).length === 1);
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
  assert.equal(artifacts.length, 1);
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

test("resumed runs continue task versions and identical patches do not create a version", async (t) => {
  const fixture = createFixture(t);
  fixture.start("first");
  writeFileSync(join(fixture.repo, "tracked.txt"), "first change\n");
  const first = fixture.capture("first");
  fixture.start("second");
  fixture.ledger.append({ source: "host-codex", source_event_id: "resume-conversation", source_ts: "2031-01-01T00:00:00Z",
    kind: "run.updated", subject: "run:second", confidence: "confirmed", payload: { conversation_id: "first", generation: 2 } });
  assert.equal(fixture.capture("second").id, first.id);
  writeFileSync(join(fixture.repo, "tracked.txt"), "corrected change\n");
  const second = fixture.capture("second");
  assert.equal(second.version, 2);
  assert.equal(second.previous_artifact_id, first.id);
  assert.equal(second.run_id, "second");
  assert.equal(fixture.capture("second", { passed: true }).id, second.id);
  assert.equal(fixture.ledger.readSince(0, 1000).filter((fact) => fact.kind === "artifact.version_created").length, 2);
});

test("different conversations in one task continue versions without including another task", (t) => {
  const fixture = createFixture(t);
  for (const [conversation, task] of [["first", "task"], ["second", "task"], ["unrelated", "other-task"]]) {
    fixture.ledger.append({ source: "host-codex", source_event_id: `conversation:${conversation}`, source_ts: "2029-01-01T00:00:00Z",
      kind: "conversation.created", subject: `conversation:${conversation}`, confidence: "confirmed",
      payload: { provider: "codex", native_id: conversation, type: "interactive", origin: "managed", task_id: task, history_format: "jsonl" } });
  }
  fixture.start("first");
  writeFileSync(join(fixture.repo, "tracked.txt"), "first change\n");
  const first = fixture.capture("first");
  fixture.start("unrelated");
  const unrelated = fixture.capture("unrelated");
  assert.equal(unrelated.version, 1);
  assert.equal(unrelated.previous_artifact_id, undefined);
  fixture.start("second");
  writeFileSync(join(fixture.repo, "tracked.txt"), "second change\n");
  const second = fixture.capture("second");
  assert.equal(second.version, 2);
  assert.equal(second.previous_artifact_id, first.id);
});

test("concurrent asynchronous captures create exactly one version for an unchanged patch", async (t) => {
  const fixture = createFixture(t);
  fixture.start("concurrent");
  writeFileSync(join(fixture.repo, "tracked.txt"), "concurrent change\n");
  const artifacts = await Promise.all(Array.from({ length: 3 }, (_, index) => finalizeArtifactsAsync(fixture.ledger,
    { runId: "concurrent", provider: "codex", sourceEventId: `concurrent:${index}`, sourceTs: "2031-01-01T00:00:00Z" },
    { blobDirectory: fixture.blobs })));
  assert.ok(artifacts[0]);
  assert.ok(artifacts.every((artifact) => artifact?.id === artifacts[0]!.id));
  assert.equal(fixture.ledger.readSince(0, 1000).filter((fact) => fact.kind === "artifact.version_created").length, 1);
});

test("resuming after a commit retains the task diff base and skips the unchanged version", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("committed-first");
  fixture.commit(fixture.repo, "first committed change\n");
  const first = fixture.capture("committed-first");
  const resumedTree = fixture.start("committed-resumed");
  assert.notEqual(resumedTree.base_sha, tree.base_sha);
  fixture.ledger.append({ source: "host-codex", source_event_id: "committed-resume", source_ts: "2031-01-01T00:00:00Z",
    kind: "run.updated", subject: "run:committed-resumed", confidence: "confirmed",
    payload: { conversation_id: "committed-first", generation: 2 } });
  assert.equal(fixture.capture("committed-resumed").id, first.id);
  fixture.commit(fixture.repo, "corrected committed change\n");
  const second = fixture.capture("committed-resumed");
  assert.equal(second.version, 2);
  assert.equal(second.previous_artifact_id, first.id);
  assert.equal(second.base_sha, first.base_sha);
  assert.ok(fixture.readPatch(second.patch_hash).includes("-base\n+corrected committed change"));
  assert.equal(fixture.ledger.readSince(0, 1000).filter((fact) => fact.kind === "artifact.version_created").length, 2);
});

test("dedicated trees used by multiple runs become joint at file level", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("owner", "worktree");
  fixture.ledger.append({ source: "host-codex", source_event_id: "peer", source_ts: "2031-01-01T00:00:00Z",
    kind: "run.created", subject: "run:peer", confidence: "confirmed", payload: { conversation_id: "peer", generation: 1, state: "running" } });
  fixture.ledger.append({ source: "host-codex", source_event_id: "peer-tree", source_ts: "2031-01-01T00:00:01Z",
    kind: "run.updated", subject: "run:peer", confidence: "confirmed", payload: { ...tree } });
  writeFileSync(join(tree.cwd, "tracked.txt"), "joint edit\n");
  writeFileSync(join(tree.cwd, "new.txt"), "joint new\n");
  const artifact = fixture.capture("owner");
  assert.equal(artifact.attribution, "joint");
  assert.deepEqual(artifact.file_attribution, [{ file: "new.txt", attribution: "joint" }, { file: "tracked.txt", attribution: "joint" }]);
});

test("shared files store line attribution only when committed and uncommitted additions mix", (t) => {
  const fixture = createFixture(t);
  fixture.start("mixed");
  const head = fixture.commit(fixture.repo, "committed line\nbase\n");
  fixture.result("mixed", { success: true, head_sha: head });
  writeFileSync(join(fixture.repo, "tracked.txt"), "committed line\nbase\nuncommitted line\n");
  writeFileSync(join(fixture.repo, "new.txt"), "untracked\n");
  const artifact = fixture.capture("mixed");
  assert.deepEqual(artifact.file_attribution, [
    { file: "new.txt", attribution: "unknown" },
    { file: "tracked.txt", attribution: "unknown", line_attribution: [{ line: 1, side: "new", attribution: "inferred" }, { line: 3, side: "new", attribution: "unknown" }] },
  ]);
});

test("artifact recapture stays responsive with 2000 commits", async (t) => {
  const fixture = createFixture(t);
  const historySize = 2000;
  const input = Array.from({ length: historySize }, (_, index) => {
    const body = `history ${index}\n`;
    return `commit refs/heads/history\ncommitter Test <test@example.invalid> ${1700000000 + index} +0000\ndata 7\nhistory\n${index === 0 ? `from ${runGit(fixture.repo, "rev-parse", "HEAD")}\n` : ""}M 100644 inline history.txt\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }).join("");
  const imported = spawnSync("git", ["fast-import", "--quiet"], { cwd: fixture.repo, input });
  assert.equal(imported.status, 0, imported.stderr.toString());
  assert.equal(Number(runGit(fixture.repo, "rev-list", "--count", "history")), historySize + 1);
  runGit(fixture.repo, "checkout", "history");
  const origin = fixture.commit(fixture.repo, "picked from large history\n");
  runGit(fixture.repo, "checkout", "main");
  fixture.start("large");
  runGit(fixture.repo, "cherry-pick", origin);
  let lastTick = performance.now();
  let maximumGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maximumGap = Math.max(maximumGap, now - lastTick); lastTick = now; }, 5);
  try {
    for (let index = 0; index < 2; index++) await finalizeArtifactsAsync(fixture.ledger,
      { runId: "large", provider: "codex", sourceEventId: `large:${index}`, sourceTs: "2031-01-01T00:00:00Z" },
      { blobDirectory: fixture.blobs });
    maximumGap = Math.max(maximumGap, performance.now() - lastTick);
  } finally { clearInterval(timer); }
  t.diagnostic(`Maximum event loop gap: ${maximumGap.toFixed(1)} ms`);
  assert.ok(maximumGap < 100, `Event loop stalled for ${maximumGap} ms`);
  const artifacts = projectArtifacts(fixture.ledger.readSince(0, 1000));
  assert.equal(artifacts.length, 1);
  const artifact = artifacts[0] as unknown as { commit_relations: { original_sha: string }[] };
  assert.equal(artifact.commit_relations[0].original_sha, runGit(fixture.repo, "rev-parse", "history"));
});

test("requests received during capture collapse into one latest recapture", async (t) => {
  const fixture = createFixture(t);
  const host = new FakeHost("codex");
  const supervisor = new Supervisor(fixture.ledger, () => {}, { recover: false, isolation: "shared", artifacts: { blobDirectory: fixture.blobs } });
  supervisor.registerHost(host);
  await supervisor.start("codex", { runId: "coalesced", conversationId: "coalesced", generation: 1,
    cwd: fixture.repo, input: { text: "task" }, model: { model: "fake" } });
  const directory = join(fixture.repo, ".git", "capture-test");
  mkdirSync(directory);
  const log = join(directory, "commands");
  writeFileSync(log, "");
  const git = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(directory, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nsleep 0.02\nexec '${git}' "$@"\n`, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath}`;
  try {
    writeFileSync(join(fixture.repo, "tracked.txt"), "initial\n");
    host.emit("coalesced", { type: "state", state: "idle" });
    await waitUntil(() => readFileSync(log, "utf8").includes("rev-parse"));
    writeFileSync(join(fixture.repo, "tracked.txt"), "latest\n");
    for (let index = 0; index < 20; index++) {
      host.emit("coalesced", { type: "fact", fact: { source_event_id: `pending:${index}`, source_ts: new Date().toISOString(),
        kind: "message.created", subject: `message:pending:${index}`, confidence: "confirmed",
        payload: { provider: "codex", native_id: `pending:${index}`, version: 1, role: "tool", tool_output: "changed", body_state: "stored" } } });
    }
    host.emit("coalesced", { type: "exit", exitCode: 0 });
    await supervisor.wait("coalesced");
  } finally { process.env.PATH = previousPath; }
  assert.equal(readFileSync(log, "utf8").split("\n").filter((command) => command === "rev-parse").length, 4);
  const artifacts = projectArtifacts(fixture.ledger.readSince(0, 1000));
  assert.equal(artifacts.length, 1);
  assert.ok(fixture.readPatch(artifacts[0].patch_hash!).includes("+latest"));
});

test("file attribution follows the final changed lines when dirty edits restore base context", (t) => {
  const fixture = createFixture(t);
  fixture.start("restored-context");
  const head = fixture.commit(fixture.repo, "committed\n");
  fixture.result("restored-context", { success: true, head_sha: head });
  writeFileSync(join(fixture.repo, "tracked.txt"), "committed\nbase\n");
  const artifact = fixture.capture("restored-context");
  assert.deepEqual(artifact.file_attribution, [{ file: "tracked.txt", attribution: "inferred" }]);
});

test("mixed attribution preserves Unicode and control characters in Git quoted paths", (t) => {
  const fixture = createFixture(t);
  const file = "日本語\x07.txt";
  writeFileSync(join(fixture.repo, file), "base\n");
  runGit(fixture.repo, "add", "."); runGit(fixture.repo, "commit", "-m", "named base");
  fixture.start("quoted-path");
  writeFileSync(join(fixture.repo, file), "committed\nbase\n");
  runGit(fixture.repo, "add", "."); runGit(fixture.repo, "commit", "-m", "named change");
  fixture.result("quoted-path", { success: true, head_sha: runGit(fixture.repo, "rev-parse", "HEAD") });
  writeFileSync(join(fixture.repo, file), "committed\nbase\ndirty\n");
  assert.deepEqual(fixture.capture("quoted-path").file_attribution, [{ file, attribution: "unknown", line_attribution: [
    { line: 1, side: "new", attribution: "inferred" }, { line: 3, side: "new", attribution: "unknown" },
  ] }]);
});

test("asynchronous binary capture uses the same custom redaction rules as ledger storage", async (t) => {
  const fixture = createFixture(t, ["custom-binary-secret"]);
  fixture.start("async-binary");
  writeFileSync(join(fixture.repo, "new.dat"), Buffer.from("\0custom-binary-secret\n"));
  const artifact = (await finalizeArtifactsAsync(fixture.ledger, { runId: "async-binary", provider: "codex",
    sourceEventId: "async-binary-capture", sourceTs: "2031-01-01T00:00:00Z" }, { blobDirectory: fixture.blobs }))!;
  const record = fixture.readPatch(artifact.patch_hash).split("\n").find((line) => line.startsWith("agent-graph-binary "))!;
  const content = JSON.parse(record.slice("agent-graph-binary ".length));
  assert.ok(!Buffer.from(content.new, "base64").toString("utf8").includes("custom-binary-secret"));
  fixture.ledger.append({ source: "host-codex", source_event_id: "binary-message", source_ts: "2031-01-01T00:00:01Z",
    kind: "message.created", subject: "message:binary-secret", confidence: "confirmed", payload: {
      provider: "codex", native_id: "binary-secret", role: "assistant", version: 1, body_state: "stored", body: "custom-binary-secret" } });
  assert.ok(!JSON.stringify(fixture.ledger.readSince(0, 1000)).includes("custom-binary-secret"));
});

test("an unchanged version becomes joint when another run uses its dedicated tree", (t) => {
  const fixture = createFixture(t);
  const tree = fixture.start("original-owner", "worktree");
  writeFileSync(join(tree.cwd, "tracked.txt"), "existing change\n");
  const first = fixture.capture("original-owner");
  fixture.ledger.append({ source: "host-codex", source_event_id: "reuse-run", source_ts: "2031-01-01T00:00:00Z",
    kind: "run.created", subject: "run:reuser", confidence: "confirmed",
    payload: { conversation_id: "original-owner", generation: 2, state: "running" } });
  fixture.ledger.append({ source: "host-codex", source_event_id: "reuse-tree", source_ts: "2031-01-01T00:00:01Z",
    kind: "run.updated", subject: "run:reuser", confidence: "confirmed", payload: { ...tree } });
  const repeated = fixture.capture("reuser");
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.version, 1);
  assert.equal(repeated.run_id, "original-owner");
  assert.equal(repeated.attribution, "joint");
  assert.deepEqual(repeated.file_attribution, [{ file: "tracked.txt", attribution: "joint" }]);
  const facts = fixture.ledger.readSince(0, 1000);
  assert.equal(facts.filter((fact) => fact.kind === "artifact.version_created").length, 1);
  assert.equal(projectArtifacts(facts)[0].attribution, "joint");
});

test("mixed attribution treats lines resembling diff headers as changed content", (t) => {
  const fixture = createFixture(t);
  fixture.start("header-content");
  const head = fixture.commit(fixture.repo, "++ committed\nbase\n");
  fixture.result("header-content", { success: true, head_sha: head });
  writeFileSync(join(fixture.repo, "tracked.txt"), "++ committed\nbase\n++ dirty\n");
  assert.deepEqual(fixture.capture("header-content").file_attribution, [{ file: "tracked.txt", attribution: "unknown", line_attribution: [
    { line: 1, side: "new", attribution: "inferred" }, { line: 3, side: "new", attribution: "unknown" },
  ] }]);
});
