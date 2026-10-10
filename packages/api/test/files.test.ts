/**
 * WebSocket: /ws（既存の token / Origin 認証）で snapshot の seq / generation を
 * {type:"hello",seq,generation} として送った後、次の cmd を送る。
 * {type:"cmd",cmd_id,command:"files.list"|"files.read"|"files.worktrees",
 *  payload:{projectId,path?:string,worktree?:string}}
 * projectId は project 投影の id。path は選んだ根からの相対パス（list の既定は根）。
 * worktree は files.worktrees の返す絶対パス。省略時は project の root_path。
 * 応答: {type:"ack",cmd_id,ok:true,result} / {type:"ack",cmd_id,ok:false,error}。
 * list: {worktree,path,entries:[{name,path,kind:"directory"|"file",git:GitMark[],changed,previousPath?}]}。
 * GitMark: modified / added / untracked / deleted / renamed。directory の git は空で、
 * changed が配下の変更を示す。削除された tracked ファイルも一覧に残す。
 * read: {worktree,path,size,state:"text",content} または {worktree,path,size,state:"binary"|"too_large"}。
 * worktrees: {worktree,worktrees:[{path,head?,branch?,detached}]}。
 * 読み取り要求は api が直接処理する。runner の稼働や台帳への追記は不要。
 */
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import fileSystem, { readFile, readdir, stat, realpath } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createFilesApi, handleFilesCommand, MAX_FILE_BYTES } from "../src/files/index.ts";
import { openObservationService } from "../src/service/index.ts";
import { startWebSocketServer } from "../src/ws/index.ts";
import { parseCommitLog } from '../src/files/git.ts';

const execute = promisify(execFile);
async function runGit(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", root, ...args], { encoding: "utf8" });
  return stdout;
}
async function createFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ag-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  await mkdir(root);
  await runGit(root, "init");
  await runGit(root, "config", "user.name", "Files Test");
  await runGit(root, "config", "user.email", "files@example.invalid");
  const dbPath = join(directory, "ledger.db");
  const service = openObservationService({ dbPath });
  t.after(() => service.close());
  const projectId = "repository-id";
  service.ledger.append({ source: "ui", source_event_id: "register", kind: "project.created", subject: "project:original",
    source_ts: "2026-10-07T00:00:00Z", confidence: "confirmed", payload: {
      repository_id: projectId, root_path: root, display_name: "Files", name_prefix: "Files", state: "registered",
    } });
  service.catchUp();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  t.after(() => db.close());
  const api = createFilesApi(db);
  const request = { projectId };
  async function write(path: string, body: string | Uint8Array = path) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  async function commit() {
    await runGit(root, "add", ".");
    await runGit(root, "commit", "-m", "fixture");
  }
  return { directory, root, projectId, request, service, db, api, write, commit };
}

test("lists one level, expands directories, filters ignored files and keeps tracked ignored files", async (t) => {
  const { api, request, write, commit } = await createFixture(t);
  await write("tracked.txt");
  await write("src/deep/code.ts");
  await write("src/kept.log");
  await commit();
  await write(".gitignore", "*.log\nignored/\n");
  await write("other.log");
  await write("ignored/secret.txt");
  await write("src/free.txt");
  await write("src/deep/.gitignore", "local*\n");
  await write("src/deep/local.txt");
  const root = await api.list(request);
  assert.deepEqual(root.entries.map((entry) => entry.path), ["src", ".gitignore", "tracked.txt"]);
  assert.deepEqual((await api.list({ ...request, path: "src" })).entries.map((entry) => entry.path),
    ["src/deep", "src/free.txt", "src/kept.log"]);
  assert.deepEqual((await api.list({ ...request, path: "src/deep" })).entries.map((entry) => entry.path),
    ["src/deep/.gitignore", "src/deep/code.ts"]);
  assert.deepEqual((await api.list({ ...request, path: "./src//deep/" })).entries,
    (await api.list({ ...request, path: "src/deep" })).entries);
  await assert.rejects(api.list({ ...request, path: "missing-directory" }));
  await assert.rejects(api.list({ ...request, path: "tracked.txt" }));
  await assert.rejects(api.read({ ...request, path: "ignored/secret.txt" }));
  assert.equal((await api.read({ ...request, path: "src/kept.log" })).state, "text");
});

test("returns every git mark, rename origins, deleted entries and changed ancestor directories", async (t) => {
  const { api, request, root, write, commit } = await createFixture(t);
  for (const name of ["edit.txt", "remove.txt", "old name.txt", "nested/deep/remove.txt", "clean/kept.txt"]) await write(name);
  await commit();
  await write("edit.txt", "changed");
  await write("added.txt");
  await runGit(root, "add", "added.txt");
  await write("untracked \nfile.txt");
  await rm(join(root, "remove.txt"));
  await runGit(root, "rm", "nested/deep/remove.txt");
  await runGit(root, "mv", "old name.txt", "new \nname.txt");
  const entries = (await api.list(request)).entries;
  const find = (path: string) => entries.find((entry) => entry.path === path)!;
  assert.deepEqual(find("edit.txt").git, ["modified"]);
  assert.deepEqual(find("added.txt").git, ["added"]);
  assert.deepEqual(find("untracked \nfile.txt").git, ["untracked"]);
  assert.deepEqual(find("remove.txt").git, ["deleted"]);
  assert.deepEqual(find("new \nname.txt").git, ["renamed"]);
  assert.equal(find("new \nname.txt").previousPath, "old name.txt");
  assert.equal(find("nested").changed, true);
  assert.equal(find("clean").changed, false);
  assert.deepEqual((await api.list({ ...request, path: "nested/deep" })).entries[0].git, ["deleted"]);
  await assert.rejects(api.read({ ...request, path: "remove.txt" }));
});

test("rejects traversal, absolute paths, .git and external symlinks for list and read", async (t) => {
  const { api, request, directory, root, write } = await createFixture(t);
  await write("safe.txt");
  const outside = join(directory, "repo-other");
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(root, "escape"));
  await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
  await symlink(join(outside, "missing.txt"), join(root, "dangling.txt"));
  await symlink(join(root, "safe.txt"), join(root, "inside.txt"));
  await symlink(join(root, ".git"), join(root, "metadata"));
  await symlink(join(root, ".git/config"), join(root, "metadata.txt"));
  for (const path of ["../repo-other/secret.txt", "src/../../secret.txt", outside, ".git", ".git/config", "escape", "escape/secret.txt", "escape.txt", "dangling.txt", "metadata", "metadata/config", "metadata.txt"]) {
    await assert.rejects(api.list({ ...request, path }));
    await assert.rejects(api.read({ ...request, path }));
  }
  assert.deepEqual((await api.list(request)).entries.map((entry) => entry.name), ["inside.txt", "safe.txt"]);
  assert.equal((await api.read({ ...request, path: "inside.txt" })).content, "safe.txt");
  await assert.rejects(api.list({ projectId: root }));
});

test("preserves trailing whitespace in a registered subdirectory when parsing git status", async (t) => {
  const { api, request, service, root, write, commit } = await createFixture(t);
  const subdirectory = "nested \n";
  await write(`${subdirectory}/file.txt`, "before");
  await commit();
  await write(`${subdirectory}/file.txt`, "after");
  service.ledger.append({ source: "ui", source_event_id: "move-root", kind: "project.updated", subject: "project:original",
    source_ts: "2026-10-07T01:00:00Z", confidence: "confirmed", payload: { root_path: join(root, subdirectory) } });
  const entries = (await api.list(request)).entries;
  assert.deepEqual(entries.map((entry) => entry.path), ["file.txt"]);
  assert.deepEqual(entries[0].git, ["modified"]);
  assert.equal((await api.read({ ...request, path: "file.txt" })).content, "after");
  assert.equal((await api.changes(request)).entries[0].path, 'file.txt');
  assert.ok((await api.diff({ ...request, path: 'file.txt' })).diff?.includes('+after'));
  const history = await api.commits(request);
  assert.equal(history.commits[0].fileCount, 1);
  assert.equal((await api.commit({ ...request, hash: history.commits[0].hash })).files[0].path, 'file.txt');
});

test("limits content to 1 MiB, detects binary data, and redacts text through ledger rules", async (t) => {
  const { api, request, write, db } = await createFixture(t);
  await write("large.txt", "x".repeat(MAX_FILE_BYTES + 1));
  await write("boundary.txt", "x".repeat(MAX_FILE_BYTES));
  await write("binary.dat", Buffer.from([65, 0, 66]));
  await write("invalid-utf8.dat", Buffer.from([255, 254, 65]));
  const secret = "sk-proj-abcdefghijklmnopqrstuvwx";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamtsbW5vcA==\n-----END PRIVATE KEY-----";
  await write("secret.txt", `key: ${secret}\nPASSWORD=small-secret\n${privateKey}\ncustom-value`);
  assert.deepEqual(await api.read({ ...request, path: "large.txt" }), {
    worktree: (await api.list(request)).worktree, path: "large.txt", size: MAX_FILE_BYTES + 1, state: "too_large", hash: createHash("sha256").update("x".repeat(MAX_FILE_BYTES + 1)).digest("hex"), editable: false,
  });
  assert.equal((await api.read({ ...request, path: "boundary.txt" })).content?.length, MAX_FILE_BYTES);
  for (const path of ["binary.dat", "invalid-utf8.dat"]) {
    const file = await api.read({ ...request, path });
    assert.equal(file.state, "binary");
    assert.equal(file.size, 3);
    assert.equal("content" in file, false);
  }
  const file = await api.read({ ...request, path: "secret.txt" });
  assert.equal(file.state, "text");
  assert.ok(!file.content?.includes(secret));
  assert.ok(!file.content?.includes("small-secret"));
  assert.ok(!file.content?.includes("YWJjZGVmZ2hpamtsbW5vcA=="));
  assert.match(file.content!, /\[REDACTED:/);
  let patterns: string[] = [];
  const configured = createFilesApi(db, () => ({ patterns }));
  assert.ok((await configured.read({ ...request, path: "secret.txt" })).content?.includes("custom-value"));
  patterns = ["custom-value"];
  const custom = await configured.read({ ...request, path: "secret.txt" });
  assert.ok(!custom.content?.includes("custom-value"));
});

test("selects only listed worktrees of the same repository and uses each tree's status and ignore rules", async (t) => {
  const { api, request, root, directory, write, commit } = await createFixture(t);
  await write("file.txt", "main");
  await commit();
  const tree = join(directory, "tree \nsecond");
  await runGit(root, "worktree", "add", "-b", "second", tree);
  await writeFile(join(tree, "file.txt"), "second");
  await writeFile(join(tree, ".gitignore"), "hidden.txt\n");
  await writeFile(join(tree, "hidden.txt"), "hidden");
  const trees = await api.worktrees(request);
  assert.equal(trees.worktrees.length, 2);
  const selected = trees.worktrees.find((entry) => entry.path.endsWith("tree \nsecond"))!.path;
  assert.equal((await api.read({ ...request, worktree: selected, path: "file.txt" })).content, "second");
  assert.equal((await api.read({ ...request, path: "file.txt" })).content, "main");
  const files = (await api.list({ ...request, worktree: selected })).entries;
  assert.deepEqual(files.find((entry) => entry.name === "file.txt")!.git, ["modified"]);
  assert.ok(!files.some((entry) => entry.name === ".git" || entry.name === "hidden.txt"));
  const other = join(directory, "other");
  await mkdir(other);
  await runGit(other, "init");
  for (const action of [api.list, api.read, api.worktrees]) await assert.rejects(action({ ...request, worktree: other, path: "file.txt" }));
  await assert.rejects(api.list({ ...request, worktree: join(root, ".git") }));
});

test("uses current project projection and validates the command payload", async (t) => {
  const { api, request, service, write } = await createFixture(t);
  await write("file.txt", "hello");
  // ソケットが禁止された環境でも、全ての読み取り要求の口を確かめる。
  assert.deepEqual(await handleFilesCommand(api, "files.list", request), await api.list(request));
  assert.deepEqual(await handleFilesCommand(api, "files.read", { ...request, path: "file.txt" }),
    await api.read({ ...request, path: "file.txt" }));
  assert.deepEqual(await handleFilesCommand(api, "files.worktrees", request), await api.worktrees(request));
  await assert.rejects(handleFilesCommand(api, "files.write", request), /invalid_path/);
  for (const payload of [null, [], {}, { projectId: 1 }, { ...request, path: 1 }, { ...request, worktree: false }]) {
    await assert.rejects(handleFilesCommand(api, "files.list", payload));
  }
  service.ledger.append({ source: "ui", source_event_id: "unregister", kind: "project.state_changed", subject: "project:original",
    source_ts: "2026-10-07T01:00:00Z", confidence: "confirmed", payload: { state: "unregistered" } });
  await assert.rejects(api.list(request), /Unknown registered project/);
});

test("file reads and git subprocesses leave the event loop free", async (t) => {
  const { api, request, write } = await createFixture(t);
  await write("file.txt");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { await api.read({ ...request, path: "file.txt" }); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0);
});

test("WebSocket acknowledges files commands and safe failures while runner is unavailable", { timeout: 15_000 }, async (t) => {
  const { service, directory, request, write } = await createFixture(t);
  await write("file.txt", "hello");
  let server: Awaited<ReturnType<typeof startWebSocketServer>>;
  try { server = await startWebSocketServer(service, { port: 0, runnerPath: join(directory, "missing.sock"),
    readRedactionRules: () => ({ patterns: ["hello"] }) }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EPERM"
      && "syscall" in error && error.syscall === "listen")) throw error;
    t.skip("sandbox blocks local TCP listen");
    return;
  }
  t.after(() => server.close());
  const socket = new WebSocket(`${server.wsUrl}?token=${server.token}`, { origin: server.url });
  t.after(() => socket.terminate());
  await once(socket, "open");
  const snapshot = await fetch(`${server.url}/snapshot?token=${server.token}`).then((response) => response.json());
  socket.send(JSON.stringify({ type: "hello", seq: snapshot.seq, generation: snapshot.generation }));
  let sequence = 0;
  async function command(command: string, payload: unknown) {
    const cmd_id = `file-${++sequence}`;
    const pending = once(socket, "message");
    socket.send(JSON.stringify({ type: "cmd", cmd_id, command, payload }));
    const [data] = await pending;
    const ack = JSON.parse(data.toString());
    assert.equal(ack.type, "ack");
    assert.equal(ack.cmd_id, cmd_id);
    return ack;
  }
  const list = await command("files.list", request);
  assert.equal(list.ok, true);
  assert.equal(list.result.entries[0].path, "file.txt");
  const read = await command("files.read", { ...request, path: "file.txt" });
  assert.match(read.result.content, /^\[REDACTED:secret:[0-9a-f]{4}\]$/);
  assert.equal((await command("files.worktrees", request)).result.worktrees.length, 1);
  const failure = await command("files.read", { ...request, path: "../secret" });
  assert.equal(failure.ok, false);
  assert.equal(failure.error, "Files request failed");
  assert.equal((await command("files.list", null)).ok, false);
  assert.equal((await command("files.write", { ...request, path: "file.txt", content: "changed", baseHash: read.result.hash })).error, "not_editable");
  assert.equal((await command("files.write", { ...request, path: "../outside", content: "changed", baseHash: "wrong" })).error, "invalid_path");
  await write("editable.txt", "before");
  const editable = await command("files.read", { ...request, path: "editable.txt" });
  assert.equal((await command("files.write", { ...request, path: "editable.txt", content: "after", baseHash: "wrong" })).error, "conflict");
  assert.equal((await command("files.write", { ...request, path: "editable.txt", content: "after", baseHash: editable.result.hash })).ok, true);
  assert.equal(service.ledger.readSince(0, 100).length, 1);
});

test('git commands return working tree sources, recent commits and redacted bounded patches', async (t) => {
  const { api, db, root, request, write, commit } = await createFixture(t);
  await write('src/file.txt', 'before\n'); await write('remove.txt', 'gone\n'); await commit();
  await write('src/file.txt', 'staged\n'); await runGit(root, 'add', 'src/file.txt');
  await write('src/file.txt', 'unstaged\n'); await rm(join(root, 'remove.txt'));
  await write('new name.txt', 'one\ntwo'); await write('secret.txt', 'PASSWORD=small-secret\n');
  await write('large.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
  const changes = await handleFilesCommand(api, 'files.changes', request) as Awaited<ReturnType<typeof api.changes>>;
  const file = changes.entries.find(entry => entry.path === 'src/file.txt')!;
  assert.equal(file.status, 'MM'); assert.equal(file.staged, true); assert.equal(file.unstaged, true);
  assert.equal(file.additions, 2); assert.equal(file.deletions, 2);
  assert.equal(changes.entries.find(entry => entry.path === 'new name.txt')?.additions, 2);
  for (const [mode, expected] of [['staged', '+staged'], ['unstaged', '+unstaged']] as const) {
    const patch = await handleFilesCommand(api, 'files.diff', { ...request, path: 'src/file.txt', mode }) as { diff: string; mode: string };
    assert.equal(patch.mode, mode); assert.ok(patch.diff.includes(expected));
  }
  const untracked = await api.diff({ ...request, path: 'new name.txt', mode: 'untracked' });
  assert.ok(untracked.diff?.includes('+two\n\\ No newline at end of file'));
  const configured = createFilesApi(db, () => ({ patterns: ['small-secret'] }));
  assert.ok(!(await configured.diff({ ...request, path: 'secret.txt', mode: 'untracked' })).diff?.includes('small-secret'));
  const large = await api.diff({ ...request, path: 'large.txt', mode: 'untracked' });
  assert.equal(large.state, 'too_large'); assert.equal('diff' in large, false);
  const history = await handleFilesCommand(api, 'files.commits', request) as Awaited<ReturnType<typeof api.commits>>;
  assert.equal(history.commits.length, 1);
  assert.equal(history.commits[0].subject, 'fixture'); assert.equal(history.commits[0].author, 'Files Test');
  assert.deepEqual(history.commits[0].conversation_ids, []);
  assert.equal(history.commits[0].fileCount, 2); assert.equal(history.commits[0].additions, 2);
  assert.deepEqual(history.commits[0].parents, []);
  assert.ok(history.commits[0].branches.length > 0);
  assert.deepEqual(history.commits[0].tags, []);
  const saved = await handleFilesCommand(api, 'files.commit', { ...request, hash: history.commits[0].hash }) as Awaited<ReturnType<typeof api.commit>>;
  assert.equal(saved.files.length, 2); assert.ok(saved.files.find(entry => entry.path === 'src/file.txt')?.diff?.includes('+before'));
});

test('git commands apply project, worktree and path rejection and validate arguments', async (t) => {
  const { api, root, directory, request, write, commit, service } = await createFixture(t);
  await write('file.txt', 'safe\n'); await commit();
  const hash = (await api.commits(request)).commits[0].hash;
  const outside = join(directory, 'outside.txt'); await writeFile(outside, 'outside');
  await symlink(outside, join(root, 'escape.txt')); await symlink(join(root, '.git/config'), join(root, 'metadata.txt'));
  const changes = await api.changes(request);
  assert.ok(!changes.entries.some(entry => ['escape.txt', 'metadata.txt'].includes(entry.path)));
  for (const command of ['files.changes', 'files.diff', 'files.commits', 'files.commit']) {
    for (const path of ['../outside.txt', outside, '.git/config', 'escape.txt', 'metadata.txt']) {
      await assert.rejects(handleFilesCommand(api, command, { ...request, path, hash }));
    }
    await assert.rejects(handleFilesCommand(api, command, { ...request, projectId: 'unknown', hash }));
    await assert.rejects(handleFilesCommand(api, command, { ...request, worktree: directory, hash }));
  }
  for (const payload of [{ mode: 'other' }, { limit: 0 }, { limit: 201 }, { limit: '30' }, { hash: '--all' }, { hash: 'HEAD' }]) {
    await assert.rejects(handleFilesCommand(api, 'files.commits', { ...request, ...payload }));
  }
  const tree = join(directory, 'second'); await runGit(root, 'worktree', 'add', '-b', 'second', tree);
  await writeFile(join(tree, 'file.txt'), 'second\n');
  assert.equal((await api.changes({ ...request, worktree: tree })).entries[0].path, 'file.txt');
  service.ledger.append({ source: 'ui', source_event_id: 'linked-root', kind: 'project.updated', subject: 'project:original', source_ts: '2026-10-08T00:00:00Z', confidence: 'confirmed', payload: { root_path: tree } });
  assert.equal((await api.commits({ ...request, worktree: root })).commits[0].hash, hash);

});

test('commit log preserves merge parents, branches, tags and record boundaries', () => {
  const fields = ['abcdef123456', '1111111 2222222', 'HEAD -> main, tag: v1.0, origin/main, feature', 'Author', '2026-10-08T00:00:00Z', 'Merge feature'];
  const root = ['1111111', '', '', 'Author', '2026-10-07T00:00:00Z', 'Root'];
  const commits = parseCommitLog(`${fields.join('\0')}\0\n${root.join('\0')}\0\n`);
  assert.deepEqual(commits[0].parents, ['1111111', '2222222']);
  assert.deepEqual(commits[0].branches, ['main', 'origin/main', 'feature']);
  assert.deepEqual(commits[0].tags, ['v1.0']);
  assert.equal(commits[0].subject, 'Merge feature');
  assert.equal(commits[1].hash, '1111111');
  assert.deepEqual(commits[1].parents, []);
  assert.deepEqual(parseCommitLog(''), []);
});


test("writes atomically, preserves mode and detects stale and concurrent saves", async t => {
  const { api, request, root, write } = await createFixture(t);
  await write("file.txt", "before\r\n");
  const initial = await api.read({ ...request, path: "file.txt" });
  assert.equal(initial.editable, true);
  assert.equal(initial.hash, createHash("sha256").update("before\r\n").digest("hex"));
  const oldInfo = await stat(join(root, "file.txt"));
  const saved = await handleFilesCommand(api, "files.write", { ...request, path: "file.txt", content: "after\n", baseHash: initial.hash });
  assert.deepEqual(saved, { worktree: initial.worktree, path: "file.txt", hash: createHash("sha256").update("after\n").digest("hex") });
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "after\n");
  const newInfo = await stat(join(root, "file.txt"));
  assert.notEqual(newInfo.ino, oldInfo.ino);
  assert.equal(newInfo.mode, oldInfo.mode);
  assert.deepEqual(await readdir(root), [".git", "file.txt"]);
  await assert.rejects(api.write({ ...request, path: "file.txt", content: "stale", baseHash: initial.hash }), /^Error: conflict$/);
  const current = await api.read({ ...request, path: "file.txt" });
  const results = await Promise.allSettled(["first", "second"].map(content => api.write({ ...request, path: "file.txt", content, baseHash: current.hash })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.message === "conflict").length, 1);
});

test("rejects redacted, large, binary, ignored and symlink writes", async t => {
  const { api, request, root, write, db } = await createFixture(t);
  await write("secret.txt", "PASSWORD=secret-value\n");
  await write("custom.txt", "custom-secret");
  await write("large.txt", "x".repeat(MAX_FILE_BYTES + 1));
  await write("binary.dat", Buffer.from([0, 1]));
  await write("safe.txt", "safe");
  await write(".gitignore", "ignored.txt\n");
  await write("ignored.txt", "hidden");
  await write("nested/file.txt", "nested");
  await symlink(join(root, "safe.txt"), join(root, "link.txt"));
  await symlink(join(root, "nested"), join(root, "linkdir"));
  for (const path of ["secret.txt", "large.txt", "binary.dat"]) {
    const file = await api.read({ ...request, path });
    assert.equal(file.editable, false);
    await assert.rejects(api.write({ ...request, path, content: "overwrite", baseHash: file.hash }), /^Error: not_editable$/);
  }
  const configured = createFilesApi(db, () => ({ patterns: ["custom-secret"] }));
  const custom = await configured.read({ ...request, path: "custom.txt" });
  await assert.rejects(configured.write({ ...request, path: "custom.txt", content: "overwrite", baseHash: custom.hash }), /not_editable/);
  for (const path of ["../outside", "/tmp/outside", ".git/config", "ignored.txt", "link.txt", "linkdir/file.txt"]) {
    await assert.rejects(api.write({ ...request, path, content: "overwrite", baseHash: "wrong" }), /^Error: invalid_path$/);
  }
  assert.equal(await readFile(join(root, "safe.txt"), "utf8"), "safe");
});


test("writes a sibling temporary file before rename and cleans it after rename failure", async t => {
  const { api, request, root, write } = await createFixture(t);
  await write("file.txt", "before");
  const baseHash = (await api.read({ ...request, path: "file.txt" })).hash;
  const target = join(await realpath(root), "file.txt");
  const originalRename = fileSystem.rename;
  let renames = 0;
  const stub = t.mock.method(fileSystem, "rename", async (source: string, destination: string) => {
    renames++;
    assert.equal(destination, target);
    assert.match(String(source), /\.agent-graph-.*\.tmp$/);
    assert.equal(await readFile(source, "utf8"), "after");
    assert.equal(await readFile(destination, "utf8"), "before");
    if (renames === 1) throw new Error("Injected rename failure");
    return originalRename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(api.write({ ...request, path: "file.txt", content: "after", baseHash }), /Injected rename failure/);
    assert.deepEqual(await readdir(root), [".git", "file.txt"]);
    await api.write({ ...request, path: "file.txt", content: "after", baseHash });
    assert.equal(renames, 2);
  } finally { stub.mock.restore(); syncBuiltinESMExports(); }
});
