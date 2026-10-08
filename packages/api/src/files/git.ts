import { dirname, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { open, stat, lstat, realpath, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import { redact, type RedactionRules } from '../../../core/src/ledger/redact.ts';
import type { FilesRequest, GitMark } from './index.ts';

export const MAX_FILE_BYTES = 1024 * 1024;
const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * MAX_FILE_BYTES;
const DEFAULT_COMMITS = 30;
const MAX_COMMITS = 100;
export interface GitRequest extends FilesRequest { hash?: string; limit?: number; mode?: 'staged' | 'unstaged' | 'untracked' }
export interface ChangeEntry { path: string; previousPath?: string; git: GitMark[]; status: string; staged: boolean; unstaged: boolean; additions: number; deletions: number; binary: boolean }
async function runGit(root: string, args: string[], maxBuffer = MAX_OUTPUT_BYTES) {
  const { stdout } = await execute('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer, timeout: 30_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}
function parseStats(body: string) {
  const entries: { path: string; previousPath?: string; additions: number; deletions: number; binary: boolean }[] = [];
  const records = body.split('\0');
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) continue;
    const previousPath = match[3] === '' ? records[++i] : undefined;
    const path = previousPath === undefined ? match[3] : records[++i];
    entries.push({ path, ...(previousPath === undefined ? {} : { previousPath }), additions: Number(match[1]) || 0,
      deletions: Number(match[2]) || 0, binary: match[1] === '-' });
  }
  return entries;
}
export async function locateRepository(root: string): Promise<{ root: string; metadata: string; common: string }> {
  let current = root;
  for (;;) {
    const path = resolve(current, '.git');
    let info;
    try { info = await lstat(path); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (info) {
      if (info.isSymbolicLink()) throw new Error('Invalid Git metadata');
      const metadata = info.isDirectory() ? path : resolve(current, (await readFile(path, 'utf8')).replace(/^gitdir: /, '').replace(/\n$/, ''));
      let common = metadata;
      try { common = resolve(metadata, (await readFile(resolve(metadata, 'commondir'), 'utf8')).replace(/\n$/, '')); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      return { root: current, metadata: await realpath(metadata), common: await realpath(common) };
    }
    const parent = dirname(current); if (parent === current) throw new Error('Not a Git repository'); current = parent;
  }
}
export function createGitApi(selectRoot: (request: FilesRequest) => Promise<string>, resolveInside: (root: string, path: string, allowMissing?: boolean) => Promise<string>, readRules: () => RedactionRules) {
  async function check(root: string, request: FilesRequest) {
    await resolveInside(root, request.path ?? '', true);
  }
  async function safe(root: string, path: string, previousPath?: string) {
    try { await resolveInside(root, path, true); if (previousPath) await resolveInside(root, previousPath, true); return true; }
    catch (error) {
      if (error instanceof Error && /Invalid project-relative path|outside project root|symlink|Git metadata/i.test(error.message)) return false;
      throw error;
    }
  }
  async function readUntracked(root: string, path: string, countOnly = false) {
    const target = await resolveInside(root, path);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Not a regular file');
      const current = await resolveInside(root, path);
      const currentInfo = await stat(current);
      if (current !== target || info.ino !== currentInfo.ino || info.dev !== currentInfo.dev) throw new Error('File changed while opening');
      if (!countOnly && info.size > MAX_FILE_BYTES) return { state: 'too_large' as const, additions: 0 };
      let additions = 0; let binary = false; let last = -1; let size = 0;
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (!countOnly && size > MAX_FILE_BYTES) return { state: 'too_large' as const, additions: 0 };
        const bytes = buffer.subarray(0, bytesRead);
        for (const byte of bytes) { if (byte === 10) additions++; if (byte === 0) binary = true; }
        last = bytes[bytesRead - 1];
        if (!countOnly) chunks.push(Buffer.from(bytes));
      }
      if (last !== -1 && last !== 10) additions++;
      if (binary) return { state: 'binary' as const, additions: 0 };
      return { state: 'text' as const, additions, content: countOnly ? '' : Buffer.concat(chunks).toString('utf8') };
    } finally { await handle.close(); }
  }
  async function readPatch(root: string, path: string, args: string[], mode?: string) {
    try {
      const patch = await runGit(root, args, MAX_FILE_BYTES);
      return { path, mode, state: 'text' as const, diff: redact(patch, readRules()).text };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { path, mode, state: 'too_large' as const };
      throw error;
    }
  }
  async function readCommitFiles(root: string, hash: string) {
    const stats = parseStats(await runGit(root, ['log', '-1', '--format=', '--numstat', '-z', '--relative', '--root', '--diff-merges=first-parent', hash, '--', '.']));
    const files = [];
    for (const entry of stats) if (await safe(root, entry.path, entry.previousPath)) files.push(entry);
    return files;
  }
  return {
    async changes(request: GitRequest) {
      const root = await selectRoot(request); await check(root, request);
      const repository = await locateRepository(root);
      const prefix = relative(repository.root, root).replaceAll('\\', '/');
      const [status, unstaged, staged] = await Promise.all([
        runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', '.']),
        runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--relative', '--', '.']),
        runGit(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--relative', '--', '.']),
      ]);
      const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
      for (const entry of [...parseStats(unstaged), ...parseStats(staged)]) {
        const previous = stats.get(entry.path);
        stats.set(entry.path, { additions: entry.additions + (previous?.additions ?? 0), deletions: entry.deletions + (previous?.deletions ?? 0), binary: entry.binary || Boolean(previous?.binary) });
      }
      const entries: ChangeEntry[] = [];
      const records = status.split('\0');
      for (let i = 0; i < records.length; i++) {
        const record = records[i]; const type = record[0];
        if (!['1', '2', 'u', '?'].includes(type)) continue;
        const fields = type === '?' ? 1 : type === '1' ? 8 : type === '2' ? 9 : 10;
        let offset = 0;
        for (let j = 0; j < fields; j++) offset = record.indexOf(' ', offset) + 1;
        const original = record.slice(offset); const previous = type === '2' ? records[++i] : undefined;
        const base = prefix ? `${prefix}/` : '';
        if (!original.startsWith(base)) continue;
        const path = original.slice(base.length);
        const previousPath = previous?.startsWith(base) ? previous.slice(base.length) : undefined;
        if (!await safe(root, path, previousPath)) continue;
        const xy = type === '?' ? '??' : record.split(' ')[1];
        const git: GitMark[] = type === '?' ? ['untracked'] : [];
        if (/[MTU]/.test(xy) || type === 'u') git.push('modified');
        if (/[AC]/.test(xy)) git.push('added'); if (xy.includes('D')) git.push('deleted'); if (xy.includes('R')) git.push('renamed');
        const counts = stats.get(path);
        const untracked = type === '?' ? await readUntracked(root, path, true) : undefined;
        entries.push({ path, previousPath, git, status: xy, staged: type !== '?' && xy[0] !== '.', unstaged: type !== '?' && xy[1] !== '.',
          additions: untracked?.additions ?? counts?.additions ?? 0, deletions: counts?.deletions ?? 0,
          binary: untracked?.state === 'binary' || Boolean(counts?.binary) });
      }
      return { worktree: root, entries };
    },
    async diff(request: GitRequest) {
      const root = await selectRoot(request); await check(root, request);
      const path = request.path; if (!path) throw new Error('File path required');
      const mode = request.mode ?? 'unstaged';
      if (mode === 'untracked') {
        const status = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--', path]);
        if (!status.startsWith('? ')) throw new Error('File is not untracked');
        const result = await readUntracked(root, path);
        if (result.state !== 'text') return { worktree: root, path, mode, state: result.state };
        const content = result.content ?? '';
        const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
        const quoted = JSON.stringify(`b/${path}`);
        const patch = `diff --git ${JSON.stringify(`a/${path}`)} ${quoted}\nnew file mode 100644\n--- /dev/null\n+++ ${quoted}\n` + (content ? `@@ -0,0 +1,${result.additions} @@\n${lines.map(line => `+${line}`).join('\n')}\n${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}` : '');
        if (Buffer.byteLength(patch) > MAX_FILE_BYTES) return { worktree: root, path, mode, state: 'too_large' };
        return { worktree: root, path, mode, state: 'text', diff: redact(patch, readRules()).text };
      }
      return { worktree: root, ...await readPatch(root, path, ['diff', ...(mode === 'staged' ? ['--cached'] : []), '--no-ext-diff', '--no-textconv', '--relative', '--', path], mode) };
    },
    async commits(request: GitRequest) {
      const root = await selectRoot(request); await check(root, request);
      let output: string;
      const repository = await locateRepository(root);
      try { output = await runGit(root, ['log', `-${request.limit ?? DEFAULT_COMMITS}`, '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00', ...(repository.root === root ? [] : ['--', '.'])]); }
      catch (error) { if (error instanceof Error && 'stderr' in error && /does not have any commits yet|unknown revision.*HEAD/.test(String(error.stderr))) return { worktree: root, commits: [] }; throw error; }
      const commits = [];
      const values = output.split('\0');
      for (let i = 0; i + 4 < values.length; i += 5) {
        const hash = values[i].trim(); if (!hash) continue;
        const files = await readCommitFiles(root, hash);
        commits.push({ hash, shortHash: values[i + 1], subject: redact(values[i + 2], readRules()).text, author: redact(values[i + 3], readRules()).text,
          time: values[i + 4], fileCount: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) });
      }
      return { worktree: root, commits };
    },
    async commit(request: GitRequest) {
      const root = await selectRoot(request); await check(root, request);
      if (!request.hash || !/^[0-9a-f]{7,64}$/i.test(request.hash)) throw new Error('Invalid commit hash');
      const entries = await readCommitFiles(root, request.hash);
      const files = [];
      for (const entry of entries) files.push({ ...entry, ...await readPatch(root, entry.path, ['log', '-1', '--format=', '-p', '--root', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', '--relative', request.hash, '--', ...(entry.previousPath ? [entry.previousPath] : []), entry.path]) });
      return { worktree: root, hash: request.hash, files };
    },
  };
}
export function validateGitRequest(request: GitRequest) {
  if (request.mode !== undefined && !['staged', 'unstaged', 'untracked'].includes(request.mode)
    || request.hash !== undefined && (typeof request.hash !== 'string' || !/^[0-9a-f]{7,64}$/i.test(request.hash))
    || request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_COMMITS)) throw new Error('Invalid git request');
}
