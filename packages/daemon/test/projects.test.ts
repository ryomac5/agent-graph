import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addProject, pickFolder } from "../src/projects.ts";
import { repoKey } from "../../core/src/paths.ts";
import { openStore, type Store } from "../../core/src/store/store.ts";
import { lastActivityAt } from "../../core/src/store/queries.ts";

test("フォルダ選択は選んだパスを返し、取り消しは undefined、ほかの失敗は投げる", async () => {
  const calls: string[][] = [];
  assert.equal(await pickFolder(async (file, args) => { calls.push([file, ...args]); return { stdout: "/Users/r/work/app/\n" }; }), "/Users/r/work/app");
  assert.equal(calls[0][0], "osascript");
  assert.ok(calls[0].some((arg) => arg.includes("choose folder")));
  assert.equal(await pickFolder(async () => { throw Object.assign(new Error("failed"), { stderr: "execution error: User canceled. (-128)" }); }), undefined);
  await assert.rejects(pickFolder(async () => { throw new Error("no display"); }), /no display/);
});

test("Git のフォルダを登録して追加の印を残し、二度目は既にあると返し、Git でなければ断る", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ag-add-")));
  const plain = mkdtempSync(join(tmpdir(), "ag-plain-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); });
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "sub"));
  const key = repoKey(root);
  const store = openStore(":memory:");
  t.after(() => store.close());
  const stores = new Map<string, Store>([[key, store]]);
  const now = new Date("2026-10-07T01:00:00.000Z");
  const added = await addProject(join(root, "sub"), stores, undefined, now);
  assert.deepEqual(added, { ok: true, message: `Added ${root.split("/").pop()}`, key }, "下のフォルダを選んでも Git の根を登録する");
  assert.equal(store.db.prepare("SELECT root_path FROM repos WHERE key = ?").get(key)!.root_path, root);
  assert.equal(lastActivityAt(store.db, key), now.toISOString(), "追加した時刻を最後の動きにして Recent に出す");
  assert.match((await addProject(root, stores)).message, /already added/);
  assert.deepEqual(await addProject(plain, stores), { ok: false, message: `${plain} is not a Git repository` });
  assert.equal((await addProject("relative/path", stores)).ok, false);
});
