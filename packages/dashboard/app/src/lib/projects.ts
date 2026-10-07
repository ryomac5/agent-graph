import type { Row, ScreenState } from './store.ts';

export const OTHER_PROJECT = 'other';
export function getRegisteredProjects(state: ScreenState): Row[] {
  return (state.projection.projects ?? []).filter(row => row.state === 'registered')
    .sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')));
}
export function getProjectName(state: ScreenState, id: string): string {
  const resolved = resolveProjectId(state, id);
  return String(state.projection.projects?.find(row => row.id === resolved && row.state === 'registered')?.display_name || 'Other');
}

// 投影の projects ごとに、識別子と場所と名前から識別子を引く索引を一度だけ作る。
const INDEXES = new WeakMap<Row[], Map<string, string>>();
function readIndex(state: ScreenState): Map<string, string> {
  const rows = state.projection.projects ?? [];
  let index = INDEXES.get(rows);
  if (!index) {
    index = new Map();
    // 識別子を最優先にし、場所、表示名、前置きの順で引く。登録したものを登録外より優先する。
    const ordered = [...rows].sort((a, b) => Number(b.state === 'registered') - Number(a.state === 'registered'));
    for (const field of ['id', 'root_path', 'display_name', 'name_prefix']) {
      for (const row of ordered) {
        const key = row[field];
        if (typeof key === 'string' && key && typeof row.id === 'string' && !index.has(key)) index.set(key, row.id);
      }
    }
    INDEXES.set(rows, index);
  }
  return index;
}

/** 経路のプロジェクトは表示名でも識別子でも場所でも受け、投影の projects の識別子に揃える。 */
export function resolveProjectId(state: ScreenState, project: string): string {
  if (!project || project === OTHER_PROJECT) return project;
  return readIndex(state).get(project) ?? project;
}

/**
 * 経路のプロジェクトに属するかを判定する関数を返す。候補には投影の各所のプロジェクトの値を渡す。
 * Other は、登録したプロジェクトに結べないものを集める。
 */
export function createProjectMatcher(state: ScreenState, project: string): (candidates: unknown[]) => boolean {
  const id = resolveProjectId(state, project);
  const registered = new Set(getRegisteredProjects(state).map(row => String(row.id)));
  const resolve = (value: unknown) => typeof value === 'string' && value ? resolveProjectId(state, value) : '';
  if (id === OTHER_PROJECT) return candidates => !candidates.some(value => registered.has(resolve(value)));
  return candidates => candidates.some(value => typeof value === 'string' && value !== '' && (value === project || resolve(value) === id));
}

/** 候補のうち、登録したプロジェクトに結べる最初のものを返す。結べなければ Other にする。 */
export function selectRegisteredProject(state: ScreenState, candidates: unknown[]): string {
  const registered = new Set(getRegisteredProjects(state).map(row => String(row.id)));
  for (const value of candidates) {
    if (typeof value !== 'string' || !value) continue;
    const id = resolveProjectId(state, value);
    if (registered.has(id)) return id;
  }
  return OTHER_PROJECT;
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
