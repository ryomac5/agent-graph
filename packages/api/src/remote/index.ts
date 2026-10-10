import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { settingsPaths, writeAtomic } from '../settings/index.ts';
import { parseSettingsToml, updateSettingsToml } from '../settings/toml.ts';
import type { FilesRequest } from '../files/index.ts';

export type ExecutionTarget = { kind: 'local' } | { kind: 'ssh'; id: string };
export interface SshConnection { id: string; name: string; destination: string; projects: { projectId: string; path: string }[] }
export type Execute = (file: string, args: string[]) => Promise<string>;
export const execute: Execute = async (file, args) => (await promisify(execFile)(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 })).stdout;
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5'];
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export function quoteShell(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new TypeError('Invalid shell argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function validateTarget(value: unknown): ExecutionTarget {
  if (value === undefined) return { kind: 'local' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid target');
  const row = value as Record<string, unknown>;
  if (row.kind === 'local' && Object.keys(row).length === 1) return { kind: 'local' };
  if (row.kind === 'ssh' && Object.keys(row).length === 2 && typeof row.id === 'string' && SAFE_ID.test(row.id)) return { kind: 'ssh', id: row.id };
  throw new TypeError('Invalid target');
}
export function validateName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(value) || value.includes('..') || value.endsWith('.') || value.endsWith('.lock')) throw new TypeError('Invalid worktree name');
  return value;
}
export function validateBase(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.')
    || value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new TypeError('Invalid base');
  return value;
}
export function validateConnections(value: unknown): SshConnection[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid SSH connections');
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !SAFE_ID.test(row.id) || ids.has(row.id)
      || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 128
      || typeof row.destination !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(row.destination)
      || !Array.isArray(row.projects)) throw new TypeError('Invalid SSH connection');
    ids.add(row.id);
    const projects = new Set<string>();
    return { id: row.id, name: row.name, destination: row.destination, projects: row.projects.map((project: { projectId: unknown; path: unknown }) => {
      if (typeof project.projectId !== 'string' || !project.projectId || projects.has(project.projectId)
        || typeof project.path !== 'string' || !project.path || /[\0\r\n]/.test(project.path)
        || !(project.path.startsWith('/') || project.path.startsWith('~/'))) throw new TypeError('Invalid remote project path');
      projects.add(project.projectId);
      return { projectId: project.projectId, path: project.path };
    }) };
  });
}
export function cacheRoot(env = process.env, home = homedir()): string {
  const root = env.XDG_CACHE_HOME || join(home, '.cache');
  if (!isAbsolute(root)) throw new TypeError('Cache path must be absolute');
  return join(root, 'agent-graph');
}
export function remotePath(path: string): string {
  return path.startsWith('~/') ? `"$HOME"/${quoteShell(path.slice(2))}` : quoteShell(path);
}
export function buildLaunchCommand(path: string, provider: 'claude' | 'codex', resume?: string, model?: string): string {
  if (!['claude', 'codex'].includes(provider) || resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)
    || model && !/^[a-z0-9][a-z0-9._-]*$/i.test(model)) throw new TypeError('Invalid session launch');
  const args = provider === 'codex' && resume ? ['resume', resume] : resume ? ['--resume', resume] : [];
  if (model) args.push('--model', model);
  return `cd ${remotePath(path)} && printf '\\033]777;agent-graph-pid=%s\\007' "$$" && exec ${provider}${args.map(arg => ` ${quoteShell(arg)}`).join('')}`;
}
export interface TargetOptions { execute?: Execute; settingsPath?: string; cache?: string; spawnStream?: typeof spawn }
export function createTargetService(selectRoot: (request: FilesRequest) => Promise<string>, options: TargetOptions = {}) {
  const run = options.execute ?? execute;
  const path = options.settingsPath ?? join(dirname(settingsPaths(process.cwd()).config), 'ssh.toml');
  let queue: Promise<unknown> = Promise.resolve();
  const created = new Map<string, string>();
  async function read(): Promise<SshConnection[]> {
    let text: string;
    try { text = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return validateConnections(parseSettingsToml(text).connections ?? []);
  }
  async function resolve(projectId: string, target: ExecutionTarget) {
    const local = await selectRoot({ projectId });
    if (target.kind === 'local') return { path: local, local };
    const connection = (await read()).find(row => row.id === target.id);
    const project = connection?.projects.find(row => row.projectId === projectId);
    if (!connection || !project) throw new TypeError('Remote project is not configured');
    return { path: project.path, local, connection };
  }
  async function ssh(connection: SshConnection, command: string): Promise<string> {
    return run('ssh', [...SSH_OPTIONS, connection.destination, '--', command]);
  }
  return {
    read, resolve, ssh, run, cache: options.cache ?? cacheRoot(), spawnStream: options.spawnStream ?? spawn,
    async launchLocation(projectId: string, target: ExecutionTarget, worktree?: unknown) {
      const location = await resolve(projectId, target);
      if (worktree === undefined) return location;
      if (typeof worktree !== 'string') throw new TypeError('Invalid worktree');
      if (target.kind === 'local') return { ...location, path: await selectRoot({ projectId, worktree }) };
      if (created.get(JSON.stringify([projectId, target, worktree])) !== worktree) throw new TypeError('Unknown remote worktree');
      return { ...location, path: worktree };
    },
    async handle(command: string, payload: unknown) {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (command === 'ssh.read') return { connections: await read() };
      if (command === 'ssh.write') {
        const connections = validateConnections(p.connections);
        const pending = queue.then(() => writeAtomic(path, updateSettingsToml('', { connections })));
        queue = pending.catch(() => undefined); await pending;
        return { saved: true };
      }
      if (command === 'ssh.test') {
        const row = validateConnections([{ id: 'test', name: 'test', destination: p.destination, projects: [] }])[0];
        try { await run('ssh', [...SSH_OPTIONS, row.destination, 'true']); return { connected: true }; } catch { return { connected: false }; }
      }
      if (!p || typeof p.projectId !== 'string' || !p.projectId) throw new TypeError('Invalid project');
      const target = validateTarget(p.target);
      // 変更を始める前に入力を検証する。
      const name = command === 'worktree.create' ? validateName(p.name) : '';
      const base = command === 'worktree.create' ? validateBase(p.base) : '';
      const location = await resolve(p.projectId, target);
      if (command === 'git.branches') {
        const body = location.connection ? await ssh(location.connection, `git -C ${remotePath(location.path)} branch -a --no-color`)
          : await run('git', ['-C', location.path, 'branch', '-a', '--no-color']);
        return { branches: [...new Set(body.split('\n').filter(line => !line.includes(' -> ')).map(line => line.replace(/^[*+ ]+/, '').replace(/^remotes\//, '').trim()).filter(Boolean))] };
      }
      if (command !== 'worktree.create') throw new TypeError('Unknown target command');
      const project = SAFE_ID.test(p.projectId) && !p.projectId.includes('..') ? p.projectId : createHash('sha256').update(p.projectId).digest('hex');
      let tree: string;
      if (location.connection) {
        const root = (await ssh(location.connection, 'printf "%s" "${XDG_CACHE_HOME:-$HOME/.cache}"')).trim();
        if (!root.startsWith('/')) throw new TypeError('Invalid remote cache path');
        tree = `${root}/agent-graph/worktrees/${project}/${name}`;
        await ssh(location.connection, `mkdir -p ${quoteShell(dirname(tree))} && git -C ${remotePath(location.path)} worktree add -b ${quoteShell(name)} ${quoteShell(tree)} ${quoteShell(base)}`);
      } else {
        tree = join(options.cache ?? cacheRoot(), 'worktrees', project, name);
        await mkdir(dirname(tree), { recursive: true });
        await run('git', ['-C', location.path, 'worktree', 'add', '-b', name, tree, base]);
      }
      created.set(JSON.stringify([p.projectId, target, tree]), tree);
      return { path: tree };
    },
  };
}
export type TargetService = ReturnType<typeof createTargetService>;
