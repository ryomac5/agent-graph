export const PROJECT_LIST_KEY = 'agent-graph-project-list';
export interface ProjectListPreferences { order: string[]; hidden: string[] }
export function loadProjectList(storage: Pick<Storage, 'getItem'> = localStorage): ProjectListPreferences {
  try {
    const value = JSON.parse(storage.getItem(PROJECT_LIST_KEY) ?? '{}');
    const readIds = (ids: unknown): string[] => Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : [];
    return { order: readIds(value?.order), hidden: readIds(value?.hidden) };
  } catch { return { order: [], hidden: [] }; }
}
export function reconcileProjectList(value: ProjectListPreferences, ids: string[]): ProjectListPreferences {
  // 一時的に投影から消えた識別子も残し、再接続で順序と非表示を失わない。
  return { ...value, order: [...value.order, ...ids.filter(id => !value.order.includes(id))] };
}
export function moveProject(value: ProjectListPreferences, visible: string[], id: string, position: number): ProjectListPreferences {
  const reordered = visible.filter(entry => entry !== id);
  reordered.splice(Math.max(0, Math.min(reordered.length, position)), 0, id);
  let index = 0;
  return { ...value, order: value.order.map(entry => visible.includes(entry) ? reordered[index++] : entry) };
}
