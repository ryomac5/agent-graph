import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildChanges, sessionsFor, type SessionRef } from "../src/git-changes.ts";
import { commitDiff, parseDiff } from "../src/git-diff.ts";
import { commitCommands } from "../src/claude-observe.ts";
import { parseCodexRows } from "../src/codex-observe.ts";

const names = new Map<string, SessionRef>([
  ["a", { id: "a", name: "repo-001", client: "claude" }],
  ["b", { id: "b", name: "repo-002", client: "codex" }],
]);

function repo(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "ag-changes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (args: string[], date?: string) => execFileSync("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "r", GIT_AUTHOR_EMAIL: "r@x", GIT_COMMITTER_NAME: "r", GIT_COMMITTER_EMAIL: "r@x",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } }).toString();
  run(["init", "-q", "-b", "main"]);
  const commit = (file: string, subject: string, date: string) => {
    writeFileSync(join(root, file), subject);
    run(["add", file]);
    run(["commit", "-q", "-m", subject], date);
  };
  return { root, run, commit };
}

test("件名を含むコマンドのセッションを選び、無ければ前後 2 分のコマンドで選ぶ", () => {
  const commands = [
    { sessionId: "a", at: "2026-10-06T10:00:00.000Z", command: 'git commit -m "一覧を直す"' },
    { sessionId: "b", at: "2026-10-06T10:00:30.000Z", command: "git commit -F msg.txt" },
  ];
  assert.deepEqual(sessionsFor({ subject: "一覧を直す", at: "2026-10-06T10:00:05.000Z" }, commands, names).map((ref) => ref.name), ["repo-001"]);
  assert.deepEqual(sessionsFor({ subject: "別の件名", at: "2026-10-06T10:01:00.000Z" }, commands, names).map((ref) => ref.name), ["repo-001", "repo-002"]);
  assert.deepEqual(sessionsFor({ subject: "別の件名", at: "2026-10-06T12:00:00.000Z" }, commands, names), [], "人が手で作ったコミットには付けない");
  const forked = new Map<string, SessionRef>([
    ["old", { id: "old", name: "repo-001", client: "claude", startedAt: "2026-10-01T00:00:00.000Z" }],
    ["new", { id: "new", name: "repo-023", client: "claude", startedAt: "2026-10-06T00:00:00.000Z" }],
  ]);
  const copied = ["old", "new"].map((sessionId) => ({ sessionId, at: "2026-10-06T10:00:00.000Z", command: 'git commit -m "一覧を直す"' }));
  assert.deepEqual(sessionsFor({ subject: "一覧を直す", at: "2026-10-06T10:00:01.000Z" }, copied, forked), [{ id: "old", name: "repo-001", client: "claude" }],
    "引き継いだ会話に写ったコマンドは元のセッションだけに付ける");
});

test("既定のブランチのコミットに増減とセッションを添え、マージは取り込んだコミットをまとめ、未統合のブランチも出す", async (t) => {
  const { root, run, commit } = repo(t);
  commit("a.txt", "土台を作る", "2026-10-06T09:00:00Z");
  run(["switch", "-q", "-c", "feat/list"]);
  commit("b.txt", "一覧を作る", "2026-10-06T10:00:00Z");
  commit("c.txt", "一覧を磨く", "2026-10-06T10:10:00Z");
  run(["switch", "-q", "main"]);
  run(["merge", "-q", "--no-ff", "-m", "Merge branch 'feat/list'", "feat/list"], "2026-10-06T11:00:00Z");
  run(["switch", "-q", "-c", "feat/wip"]);
  commit("d.txt", "途中の作業", "2026-10-06T12:00:00Z");
  run(["switch", "-q", "-c", "worktree-agent-abc"]);
  commit("e.txt", "子の作業", "2026-10-06T12:30:00Z");
  run(["switch", "-q", "main"]);
  const commands = [
    { sessionId: "a", at: "2026-10-06T10:00:01.000Z", command: 'git commit -m "一覧を作る"' },
    { sessionId: "b", at: "2026-10-06T10:10:02.000Z", command: 'git commit -m "一覧を磨く"' },
    { sessionId: "b", at: "2026-10-06T12:00:01.000Z", command: 'git commit -m "途中の作業"' },
  ];
  const changes = await buildChanges(root, commands, names);
  assert.equal(changes.branch, "main");
  assert.deepEqual(changes.branches, ["main", "feat/wip"], "作業用のブランチはツリーに入れない");
  const subjects = changes.commits.map((c) => c.subject);
  assert.deepEqual(subjects, ["途中の作業", "Merge branch 'feat/list'", "一覧を磨く", "一覧を作る", "土台を作る"], "トポロジー順で子が親より先");
  const bySubject = new Map(changes.commits.map((c) => [c.subject, c]));
  const merge = bySubject.get("Merge branch 'feat/list'")!;
  assert.equal(merge.parents.length, 2);
  assert.deepEqual(merge.refs, ["main"]);
  assert.deepEqual(bySubject.get("途中の作業")!.refs, ["feat/wip"]);
  assert.deepEqual(bySubject.get("一覧を作る")!.sessions.map((ref) => ref.name), ["repo-001"]);
  assert.deepEqual(bySubject.get("一覧を磨く")!.sessions.map((ref) => ref.name), ["repo-002"]);
  assert.equal(bySubject.get("一覧を作る")!.files, 1);
  assert.deepEqual(bySubject.get("土台を作る")!.sessions, []);
  const page = await buildChanges(root, commands, names, { limit: 2 });
  assert.equal(page.hasMore, true);
  assert.equal(page.commits.length, 2);

  // 差分。普通のコミット、マージ、最初のコミット
  const plain = await commitDiff(root, bySubject.get("一覧を磨く")!.sha);
  assert.equal(plain.subject, "一覧を磨く");
  assert.deepEqual(plain.files.map((f) => [f.path, f.status, f.additions, f.deletions]), [["c.txt", "added", 1, 0]]);
  assert.deepEqual(plain.files[0].hunks[0].lines, [{ kind: "add", new: 1, text: "一覧を磨く" }]);
  const merged = await commitDiff(root, merge.sha);
  assert.deepEqual(merged.files.map((f) => f.path).sort(), ["b.txt", "c.txt"], "マージは一次の親との差分");
  const first = await commitDiff(root, bySubject.get("土台を作る")!.short);
  assert.deepEqual(first.files.map((f) => f.path), ["a.txt"]);
  await assert.rejects(commitDiff(root, "not-a-sha"), /Invalid commit/);
});

test("差分の解析は変更と削除と改名と二進と行番号を読み、大きなファイルは切る", () => {
  const output = [
    "diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ function f() {", " keep", "-old", "+new", " tail", "\\ No newline at end of file",
    "diff --git a/old.md b/new.md", "similarity index 90%", "rename from old.md", "rename to new.md",
    "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ",
  ].join("\n");
  const { files } = parseDiff(output);
  assert.deepEqual(files.map((f) => [f.path, f.oldPath, f.status, f.binary]), [
    ["src/a.ts", undefined, "modified", false], ["new.md", "old.md", "renamed", false], ["gone.txt", undefined, "deleted", false], ["img.png", undefined, "modified", true]]);
  assert.deepEqual(files[0].hunks[0].lines, [
    { kind: "ctx", old: 10, new: 10, text: "keep" }, { kind: "del", old: 11, text: "old" }, { kind: "add", new: 11, text: "new" }, { kind: "ctx", old: 12, new: 12, text: "tail" }]);
  const big = ["diff --git a/b.txt b/b.txt", "@@ -0,0 +1,2000 @@", ...Array.from({ length: 2000 }, (_, i) => `+${i}`)].join("\n");
  const parsed = parseDiff(big);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.files[0].additions, 2000, "数は全部数える");
  assert.equal(parsed.files[0].hunks[0].lines.length, 1500);
});

test("Claude と Codex の記録から git commit のコマンドを時刻つきで拾う", () => {
  assert.deepEqual(commitCommands([
    { type: "assistant", timestamp: "t1", message: { content: [{ type: "tool_use", name: "Bash", input: { command: 'git add -A && git commit -q -m "x"' } }] } },
    { type: "assistant", timestamp: "t2", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git status" } }] } },
  ]), [{ at: "t1", command: 'git add -A && git commit -q -m "x"' }]);
  const snapshot = parseCodexRows([
    { type: "session_meta", timestamp: "t0", payload: { id: "th", cwd: "/repo" } },
    { type: "response_item", timestamp: "t3", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git commit -m y" }) } },
  ]);
  assert.deepEqual(snapshot?.commands, [{ at: "t3", command: "git commit -m y" }]);
});
