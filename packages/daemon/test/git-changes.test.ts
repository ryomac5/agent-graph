import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildChanges, mergedBranch, sessionsFor, type SessionRef } from "../src/git-changes.ts";
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

test("マージの件名から取り込んだブランチを読む", () => {
  assert.equal(mergedBranch("Merge pull request #12 from ryomac5/fix/bg-sessions"), "fix/bg-sessions");
  assert.equal(mergedBranch("Merge branch 'feat/x' into main"), "feat/x");
  assert.equal(mergedBranch("一覧を直す"), "");
});

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
  assert.deepEqual(changes.commits.map((c) => c.subject), ["Merge branch 'feat/list'", "土台を作る"]);
  const merge = changes.commits[0];
  assert.equal(merge.merge?.branch, "feat/list");
  assert.deepEqual(merge.merge?.commits.map((c) => c.subject), ["一覧を磨く", "一覧を作る"]);
  assert.deepEqual(merge.sessions.map((ref) => ref.name).sort(), ["repo-001", "repo-002"]);
  assert.equal(merge.files, 2);
  assert.deepEqual(changes.commits[1].sessions, []);
  assert.deepEqual(changes.branches.map((b) => [b.name, b.ahead, b.sessions.map((ref) => ref.name)]), [["feat/wip", 1, ["repo-002"]]]);
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
