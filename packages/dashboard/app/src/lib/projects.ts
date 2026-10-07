import type { Row, ScreenState } from './store.ts';

export const OTHER_PROJECT = 'other';
export function getRegisteredProjects(state: ScreenState): Row[] {
  return (state.projection.projects ?? []).filter(row => row.state === 'registered')
    .sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')));
}
export function getProjectName(state: ScreenState, id: string): string {
  return String(state.projection.projects?.find(row => row.id === id && row.state === 'registered')?.display_name || 'Other');
}
// core の defaultTemporaryRoots と同じ境界。環境固有の場所は投影の reason も尊重する。
export function isTemporaryPath(path: string): boolean {
  const normalized = '/' + path.split('/').reduce<string[]>((parts, part) => {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
    return parts;
  }, []).join('/');
  return ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].some(root => normalized === root || normalized.startsWith(root + '/'))
    || /\/agent-graph\/worktrees(?:\/|$)/.test(normalized);
}
