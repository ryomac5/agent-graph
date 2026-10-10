import { MAX_FILE_BYTES, createGitApi, locateRepository, validateGitRequest, type GitRequest } from './git.ts';
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { projectProjects } from "../../../core/src/ledger/projections/projects.ts";
import { redact, type RedactionRules } from "../../../core/src/ledger/redact.ts";
import type { Fact } from "../../../core/src/ledger/facts.ts";
import { createCommitConversationIndex } from './conversations.ts';

export { MAX_FILE_BYTES } from './git.ts';
const MAX_GIT_OUTPUT_BYTES = 64 * MAX_FILE_BYTES;
const execute = promisify(execFile);
export type GitMark = "modified" | "added" | "untracked" | "deleted" | "renamed";
export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  git: GitMark[];
  changed: boolean;
  previousPath?: string;
}
export interface FilesWriteRequest { projectId: string; worktree?: string; path: string; content: string; baseHash: string }
export class FilesWriteError extends Error {
  constructor(code: "conflict" | "not_editable" | "invalid_path") { super(code); }
}

async function resolveWritable(root: string, path: string): Promise<string> {
  const target = await resolveInside(root, path);
  let current = root;
  for (const part of relative(root, resolve(root, path)).split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new FilesWriteError("invalid_path");
  }
  return target;
}

export interface FilesRequest { projectId: string; path?: string; worktree?: string }

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

function validatePath(path: string): void {
  if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some((part) => part === ".." || part === ".git")) {
    throw new Error("Invalid project-relative path");
  }
}

function normalizePath(path: string): string {
  validatePath(path);
  const normalized = posix.normalize(path);
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

function isInside(root: string, path: string): boolean {
  const tail = relative(root, path);
  return tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

async function resolveInside(root: string, path: string, allowMissing = false): Promise<string> {
  validatePath(path);
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new Error("Path outside project root");
  let current = target;
  for (;;) {
    try {
      const canonical = await realpath(current);
      if (!isInside(root, canonical)) throw new Error("Symlink outside project root");
      if (relative(root, canonical).split(sep).includes(".git")) throw new Error("Git metadata is not visible");
      return current === target ? canonical : target;
    } catch (error) {
      if (!allowMissing || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (current === root) throw error;
      // realpath が解けないリンクは、外向きかどうか確認できないので拒む。
      let info;
      try { info = await lstat(current); }
      catch (missing) {
        if (!(missing instanceof Error && "code" in missing && missing.code === "ENOENT")) throw missing;
      }
      if (info?.isSymbolicLink()) throw new Error("Unresolvable symlink");
      current = dirname(current);
    }
  }
}

function parseStatus(body: string, prefix: string): Map<string, { git: GitMark[]; previousPath?: string }> {
  const result = new Map<string, { git: GitMark[]; previousPath?: string }>();
  const records = body.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const type = record[0];
    if (!["1", "2", "u", "?"].includes(type)) continue;
    const fields = type === "?" ? 1 : type === "1" ? 8 : type === "2" ? 9 : 10;
    let offset = 0;
    for (let field = 0; field < fields; field++) offset = record.indexOf(" ", offset) + 1;
    const original = record.slice(offset);
    const previous = type === "2" ? records[++index] : undefined;
    if (!original.startsWith(prefix)) continue;
    const path = original.slice(prefix.length);
    const xy = record.split(" ", 3)[1];
    const git: GitMark[] = [];
    if (type === "?") git.push("untracked");
    else {
      if (xy.includes("M") || xy.includes("T") || type === "u") git.push("modified");
      if (xy.includes("A") || xy.includes("C")) git.push("added");
      if (xy.includes("D")) git.push("deleted");
      if (xy.includes("R")) git.push("renamed");
    }
    result.set(path, { git, ...(previous?.startsWith(prefix) ? { previousPath: previous.slice(prefix.length) } : {}) });
  }
  return result;
}

async function readVisiblePaths(root: string): Promise<Set<string>> {
  const [tracked, others] = await Promise.all([
    runGit(root, ["ls-files", "-z"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return new Set([...tracked.split("\0"), ...others.split("\0")].filter(Boolean));
}

async function readIndex(root: string) {
  const [paths, status, prefix] = await Promise.all([
    readVisiblePaths(root),
    runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."]),
    runGit(root, ["rev-parse", "--show-prefix"]),
  ]);
  const marks = parseStatus(status, prefix.slice(0, -1));
  for (const path of marks.keys()) paths.add(path);
  return { paths, marks };
}

async function listWorktrees(root: string) {
  const output = await runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  const trees: { path: string; head?: string; branch?: string; detached: boolean }[] = [];
  for (const block of output.split("\0\0")) {
    const fields = block.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!path || fields.includes("bare")) continue;
    trees.push({ path, head: fields.find((field) => field.startsWith("HEAD "))?.slice(5),
      branch: fields.find((field) => field.startsWith("branch "))?.slice(7), detached: fields.includes("detached") });
  }
  return trees;
}

async function readCommonDirectory(root: string): Promise<string> {
  const path = (await runGit(root, ["rev-parse", "--git-common-dir"])).slice(0, -1);
  return realpath(resolve(root, path));
}

export function createFilesApi(db: DatabaseSync, readRules: () => RedactionRules = () => ({})) {
  const conversations = createCommitConversationIndex(db);
  function readProjectRoot(projectId: string): string {
    const facts = db.prepare("SELECT * FROM facts WHERE kind LIKE 'project.%' ORDER BY seq").all()
      .map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
    const project = projectProjects(facts).find((entry) => entry.id === projectId);
    if (!project?.root_path || project.state !== "registered") {
      throw new Error("Unknown registered project");
    }
    return project.root_path;
  }
  async function selectRoot(request: FilesRequest): Promise<string> {
    const root = await realpath(readProjectRoot(request.projectId));
    if (request.worktree === undefined) return root;
    const selected = await realpath(request.worktree);
    const trees = await listWorktrees(root);
    const allowed = await Promise.all(trees.map((tree) => realpath(tree.path)));
    if (!allowed.includes(selected) || await readCommonDirectory(root) !== await readCommonDirectory(selected)) {
      throw new Error("Worktree does not belong to project repository");
    }
    return selected;
  }
  async function selectGitRoot(request: FilesRequest): Promise<string> {
    const root = await realpath(readProjectRoot(request.projectId));
    if (request.worktree === undefined || await realpath(request.worktree) === root) return root;
    const selected = await realpath(request.worktree);
    const repository = await locateRepository(root);
    const tree = await locateRepository(selected);
    if (tree.root !== selected || tree.common !== repository.common) throw new Error('Worktree does not belong to project repository');
    if (tree.metadata === tree.common && await realpath(dirname(tree.metadata)) === selected) return selected;
    if (!isInside(resolve(repository.common, 'worktrees'), tree.metadata)) throw new Error('Worktree does not belong to project repository');
    const backpointer = (await readFile(resolve(tree.metadata, 'gitdir'), 'utf8')).replace(/\n$/, '');
    if (await realpath(dirname(backpointer)) !== selected) throw new Error('Worktree does not belong to project repository');
    return selected;
  }
  const writes = new Map<string, Promise<unknown>>();
  const api = {
    selectRoot,
    ...createGitApi(selectGitRoot, resolveInside, readRules, conversations),
    async worktrees(request: FilesRequest) {
      const root = await selectRoot(request);
      return { worktree: root, worktrees: await listWorktrees(root) };
    },
    async list(request: FilesRequest) {
      const root = await selectRoot(request);
      const path = normalizePath(request.path ?? "");
      const target = await resolveInside(root, path, true);
      const { paths, marks } = await readIndex(root);
      const prefix = path === "" ? "" : `${path}/`;
      try {
        if (!(await stat(target)).isDirectory()) throw new Error("Not a directory");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"
          && [...paths].some((file) => file.startsWith(prefix)))) throw error;
      }
      const entries = new Map<string, FileEntry>();
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue;
        const tail = file.slice(prefix.length);
        const name = tail.split("/")[0];
        if (!name || name === ".git") continue;
        const entryPath = `${prefix}${name}`;
        validatePath(entryPath);
        const mark = marks.get(file);
        const kind = tail.includes("/") ? "directory" : "file";
        const previous = entries.get(entryPath);
        if (previous) previous.changed ||= Boolean(mark?.git.length);
        else entries.set(entryPath, { name, path: entryPath, kind,
          git: kind === "file" ? mark?.git ?? [] : [], changed: Boolean(mark?.git.length),
          ...(kind === "file" && mark?.previousPath ? { previousPath: mark.previousPath } : {}) });
      }
      const safe: FileEntry[] = [];
      for (const entry of entries.values()) {
        try { await resolveInside(root, entry.path, true); safe.push(entry); }
        catch (error) {
          // 外向きのリンクは一覧からも除外する。他の IO 障害は呼び出し側へ返す。
          if (!(error instanceof Error && ["Symlink outside project root", "Unresolvable symlink", "Git metadata is not visible"].includes(error.message))) throw error;
        }
      }
      return { worktree: root, path, entries: safe.sort((a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)) };
    },
    async write(request: FilesWriteRequest) {
      let root: string;
      let path: string;
      try { root = await selectRoot(request); path = normalizePath(request.path); }
      catch { throw new FilesWriteError("invalid_path"); }
      const key = resolve(root, path);
      const pending = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        let target: string;
        let file: Awaited<ReturnType<typeof api.read>>;
        try {
          target = await resolveWritable(root, path);
          file = await api.read({ ...request, path });
        } catch { throw new FilesWriteError("invalid_path"); }
        if (!file.editable || Buffer.byteLength(request.content) > MAX_FILE_BYTES
          || request.content.includes("\0")) throw new FilesWriteError("not_editable");
        if (file.hash !== request.baseHash) throw new FilesWriteError("conflict");
        const mode = (await stat(target)).mode;
        const temporary = resolve(dirname(target), ".agent-graph-" + randomUUID() + ".tmp");
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
        try {
          await handle.chmod(mode);
          await handle.writeFile(request.content, "utf8");
          await handle.sync();
          try { await resolveWritable(root, path); }
          catch { throw new FilesWriteError("invalid_path"); }
          const current = await api.read({ ...request, path });
          if (!current.editable) throw new FilesWriteError("not_editable");
          if (current.hash !== request.baseHash) throw new FilesWriteError("conflict");
          await rename(temporary, target);
          return { worktree: root, path, hash: createHash("sha256").update(request.content).digest("hex") };
        } finally {
          await handle.close();
          await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
      });
      writes.set(key, pending);
      try { return await pending; }
      finally { if (writes.get(key) === pending) writes.delete(key); }
    },
    async read(request: FilesRequest): Promise<{ worktree: string; path: string; size: number; hash: string; editable: boolean; state: "text" | "binary" | "too_large"; content?: string }> {
      const root = await selectRoot(request);
      const path = normalizePath(request.path ?? "");
      const target = await resolveInside(root, path);
      const paths = await readVisiblePaths(root);
      if (!paths.has(path)) throw new Error("File is not visible in project");
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Not a regular file");
        const current = await resolveInside(root, path);
        const currentInfo = await stat(current);
        if (current !== target || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) throw new Error("File changed while opening");
        // 全体の hash を計算しつつ、表示上限を越える本文は保持しない。
        const digest = createHash("sha256");
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        let length = 0;
        let retained = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, retained, buffer.length - retained, null);
          if (!bytesRead) break;
          digest.update(buffer.subarray(retained, retained + bytesRead));
          length += bytesRead;
          retained = length <= MAX_FILE_BYTES ? length : 0;
        }
        const hash = digest.digest("hex");
        const result = { worktree: root, path, size: length, hash, editable: false };
        if (length > MAX_FILE_BYTES) return { ...result, state: "too_large" as const };
        const bytes = buffer.subarray(0, length);
        if (bytes.includes(0) || bytes.some((byte) => byte < 32 && ![9, 10, 12, 13].includes(byte))) {
          return { ...result, state: "binary" as const };
        }
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { return { ...result, state: "binary" as const }; }
        const content = redact(text, readRules()).text;
        return { ...result, state: "text" as const, content, editable: content === text };
      } finally { await handle.close(); }
    },
  };
  return api;
}

export async function handleFilesCommand(api: ReturnType<typeof createFilesApi>, command: string, payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    if (command === "files.write") throw new FilesWriteError("invalid_path");
    throw new Error("Invalid files request");
  }
  const request = payload as FilesRequest;
  if (typeof request.projectId !== "string" || !request.projectId
    || request.path !== undefined && typeof request.path !== "string"
    || request.worktree !== undefined && typeof request.worktree !== "string") {
    if (command === "files.write") throw new FilesWriteError("invalid_path");
    throw new Error("Invalid files request");
  }
  if (command === "files.write") {
    const write = payload as FilesWriteRequest;
    if (typeof write.path !== "string") throw new FilesWriteError("invalid_path");
    if (typeof write.content !== "string" || typeof write.baseHash !== "string") throw new FilesWriteError("not_editable");
    return api.write(write);
  }
  validateGitRequest(request as GitRequest);
  if (command === "files.changes") return api.changes(request);
  if (command === "files.diff") return api.diff(request);
  if (command === "files.commits") return api.commits(request);
  if (command === "files.commit") return api.commit(request);
  if (command === "files.list") return api.list(request);
  if (command === "files.read") return api.read(request);
  if (command === "files.worktrees") return api.worktrees(request);
  throw new Error("Unknown files command");
}
