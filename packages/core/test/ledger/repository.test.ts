import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createRepositoryId, openLedger, projectProjects } from "../../src/ledger/index.ts";
import type { FactInput, ProjectPayload } from "../../src/ledger/index.ts";
import { defaultTemporaryRoots, resolveProjectLocation } from "../../src/ledger/repository.ts";

const TS = "1970-01-01T00:00:00.000Z";

function git(...args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
}

function createRepositories(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-graph-repository-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = join(dir, "projects/agent-graph");
  const store = join(dir, "cache/agent-graph/worktrees");
  const scratch = join(dir, "scratch");
  mkdirSync(main, { recursive: true });
  git("init", "--quiet", main);
  git("-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "fixture");
  const worktrees = ["A1", "W1"].map((name) => join(store, "agent-graph-1234/graph", name));
  for (const worktree of worktrees) git("-C", main, "worktree", "add", "--quiet", "--detach", worktree);
  const temporary = join(scratch, "codexpick.xPbN");
  mkdirSync(temporary, { recursive: true });
  git("init", "--quiet", temporary);
  return { dir, main, worktrees, temporary, temporaryRoots: [scratch, store], missing: join(dir, "deleted") };
}

test("作業ツリーは本体のプロジェクトに寄り、表示名は本体のディレクトリ名になる", (t) => {
  const f = createRepositories(t);
  const expected = {
    repository_id: createRepositoryId(realpathSync(join(f.main, ".git"))), root_path: f.main,
    display_name: "agent-graph", name_prefix: "agent-graph", state: "registered",
  };
  for (const root of [f.main, ...f.worktrees]) {
    assert.deepEqual(resolveProjectLocation(root, { temporaryRoots: f.temporaryRoots }), expected);
  }
});

test("一時の場所の本体と消えたリポジトリは登録しない", (t) => {
  const f = createRepositories(t);
  const temporary = resolveProjectLocation(f.temporary, { temporaryRoots: f.temporaryRoots });
  assert.equal(temporary.state, "unregistered");
  assert.equal(temporary.reason, "temporary");
  assert.equal(temporary.display_name, "codexpick.xPbN");
  const missing = resolveProjectLocation(f.missing, { temporaryRoots: f.temporaryRoots });
  assert.equal(missing.state, "unregistered");
  assert.equal(missing.reason, "missing");
  assert.equal(missing.root_path, f.missing);
  // 既定の置き場は OS の一時ディレクトリと作業ツリーの置き場を含む。
  const roots = defaultTemporaryRoots({ TMPDIR: "/custom/tmp", XDG_CACHE_HOME: "/cache" }, "/home/user");
  for (const root of ["/custom/tmp", "/private/tmp", "/var/folders", "/cache/agent-graph/worktrees"]) assert.ok(roots.includes(root));
  assert.ok(defaultTemporaryRoots({}, "/home/user").includes("/home/user/.cache/agent-graph/worktrees"));
  // 既定では、この試験の一時ディレクトリにある本体も登録しない。
  assert.equal(resolveProjectLocation(f.main).state, "unregistered");
});

test("自動の作成の表示名は本体のディレクトリ名になり、事実の並びに依存しない。明示の名前の変更は残る", (t) => {
  const repository_id = createRepositoryId("/repositories/agent-graph/.git");
  const base: ProjectPayload = { repository_id, root_path: "/repositories/agent-graph", display_name: "", name_prefix: "", state: "registered" };
  const inputs: FactInput[] = ["A1", "W1", "agent-graph", "Z1"].map((name, index) => ({
    source: "legacy", source_event_id: `row-${index}`, kind: "project.created", subject: `project:${repository_id}`,
    payload: { ...base, display_name: name, name_prefix: name }, source_ts: TS, confidence: "confirmed",
  }));
  for (const order of [inputs, [...inputs].reverse(), [inputs[2], inputs[0], inputs[3], inputs[1]]]) {
    const ledger = openLedger(":memory:");
    t.after(() => ledger.close());
    for (const input of order) ledger.append(input);
    assert.deepEqual(projectProjects(ledger.readSince(0, 100)), [{ ...base, display_name: "agent-graph", name_prefix: "agent-graph", id: repository_id }]);
    ledger.append({ source: "ui", source_event_id: "rename", kind: "project.updated", subject: `project:${repository_id}`,
      payload: { display_name: "Agent Graph" }, source_ts: "2026-01-01T00:00:00.000Z", confidence: "confirmed" });
    assert.equal(projectProjects(ledger.readSince(0, 100))[0].display_name, "Agent Graph");
  }
});
