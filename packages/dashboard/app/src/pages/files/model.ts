import type { Ack } from '../../lib/client.ts';

export type GitMark = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed';
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file'; git: GitMark[]; changed: boolean; previousPath?: string }
export interface ListResult { worktree: string; path: string; entries: FileEntry[] }
export type ReadResult = { hash?: string; editable?: boolean } & ( { worktree: string; path: string; size: number; state: 'text'; content: string }
  | { worktree: string; path: string; size: number; state: 'binary' } | { worktree: string; path: string; size: number; state: 'too_large' });
export interface Worktree { path: string; head?: string; branch?: string; detached: boolean }
export interface WorktreesResult { worktree: string; worktrees: Worktree[] }
export interface FilesRequest { projectId: string; path?: string; worktree?: string }
export interface FilesClient { command(command: string, payload?: unknown, cmdId?: string): Promise<Ack> }

async function call<T>(client: FilesClient, command: string, request: FilesRequest): Promise<T> {
  const payload: FilesRequest = { projectId: request.projectId };
  if (request.path) payload.path = request.path;
  if (request.worktree) payload.worktree = request.worktree;
  const ack = await client.command(command, payload);
  if (!ack.ok) throw new Error(ack.error ?? `${command} failed`);
  return ack.result as T;
}
// 応答の形を確かめ、想定外の応答は読み込みの失敗として示す。
function expect<T>(check: (value: Record<string, unknown>) => boolean) {
  return (result: T): T => {
    if (!result || typeof result !== 'object' || !check(result as Record<string, unknown>)) throw new Error('Unexpected response from the files service');
    return result;
  };
}
export const listFiles = (client: FilesClient, request: FilesRequest) => call<ListResult>(client, 'files.list', request)
  .then(expect<ListResult>(value => Array.isArray(value.entries)));
export const readFile = (client: FilesClient, request: FilesRequest) => call<ReadResult>(client, 'files.read', request)
  .then(expect<ReadResult>(value => typeof value.state === 'string'));
export const listWorktrees = (client: FilesClient, request: FilesRequest) => call<WorktreesResult>(client, 'files.worktrees', request)
  .then(expect<WorktreesResult>(value => Array.isArray(value.worktrees)));

// 経路のプロジェクトの解決は、作業場と Tree と Changes と同じ規則を使う。
export { resolveProjectId } from '../../lib/projects.ts';

/** 実行の場所が作業ツリーの下にあれば、その作業ツリーを選ぶ。 */
export function matchWorktree(worktrees: Worktree[], wanted: string): Worktree | undefined {
  const trim = (value: string) => value.replace(/[\\/]+$/, '');
  const target = trim(wanted);
  return worktrees.find(tree => trim(tree.path) === target)
    ?? worktrees.filter(tree => target.startsWith(`${trim(tree.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0];
}

export function worktreeName(tree: Worktree): string {
  const place = tree.path.split(/[\\/]+/).filter(Boolean).at(-1) ?? tree.path;
  const branch = tree.branch?.replace(/^refs\/heads\//, '');
  if (branch) return `${branch} · ${place}`;
  return `${tree.detached ? 'Detached' : 'No branch'}${tree.head ? ` ${tree.head.slice(0, 7)}` : ''} · ${place}`;
}

export function parentPath(path: string): string { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''; }
export function ancestorPaths(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

export const GIT_MARKS: Record<GitMark, { letter: string; label: string }> = {
  modified: { letter: 'M', label: 'Modified' },
  added: { letter: 'A', label: 'Added' },
  untracked: { letter: 'U', label: 'Untracked' },
  deleted: { letter: 'D', label: 'Deleted' },
  renamed: { letter: 'R', label: 'Renamed' },
};
/** 名前の色は、削除、追加、未追跡、名前の変更、変更の順で強い印に従う。 */
export function primaryMark(git: GitMark[]): GitMark | undefined {
  return (['deleted', 'added', 'untracked', 'renamed', 'modified'] as const).find(mark => git.includes(mark));
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
