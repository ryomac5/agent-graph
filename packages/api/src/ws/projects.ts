import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, isAbsolute, resolve, sep } from 'node:path';
import { resolveProjectLocation, toProjectPayload } from '../../../core/src/ledger/repository.ts';
import type { UiAppender } from '../service/index.ts';
import type { ScreenCommand } from './contract.ts';
export function expandLocation(path: string, home = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? resolve(home, path.slice(2)) : path;
}
export async function addProject(append: UiAppender, message: ScreenCommand, options: { home?: string; temporaryRoots?: string[] } = {}) {
  const input = (message.payload as { path?: unknown } | undefined)?.path;
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('invalid_path');
  const path = expandLocation(input.trim(), options.home);
  if (!isAbsolute(path)) throw new Error('invalid_path');
  if (!existsSync(path)) throw new Error('missing');
  const location = resolveProjectLocation(path, { temporaryRoots: options.temporaryRoots });
  if (location.state !== 'registered') throw new Error(location.reason === 'temporary' ? 'temporary' : 'not_git');
  const result = await append({ source: 'ui', source_event_id: `project.add:${message.cmd_id}`, kind: 'project.created',
    subject: `project:${location.repository_id}`, payload: toProjectPayload(location), confidence: 'confirmed', source_ts: new Date().toISOString() });
  if (result.status === 'conflict') throw new Error('Conflicting project');
  return { projectId: location.repository_id };
}
export function listDirectories(payload: unknown, home = homedir()): { paths: string[] } {
  const input = (payload as { path?: unknown } | undefined)?.path;
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('invalid_path');
  const path = expandLocation(input || '~/', home);
  const directoryInput = !input || input.endsWith(sep) || input === '~';
  const directory = directoryInput ? path : dirname(path);
  const prefix = directoryInput ? '' : basename(path);
  const root = realpathSync(home);
  const allowed = (value: string) => (value === root || value.startsWith(root + sep)) && !value.slice(root.length).split(sep).some(part => part.startsWith('.'));
  if (!isAbsolute(directory) || !existsSync(directory)) return { paths: [] };
  const canonical = realpathSync(directory);
  if (!allowed(canonical) || !statSync(canonical).isDirectory()) return { paths: [] };
  return { paths: readdirSync(canonical, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && entry.name.startsWith(prefix) && entry.isDirectory())
    .map(entry => resolve(canonical, entry.name)).filter(value => allowed(realpathSync(value))).sort() };
}
