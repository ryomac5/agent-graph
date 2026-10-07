export interface RootProjection {
  id: string;
  name: string;
  project: string | null;
  state: string;
  last_activity_ts: string | null;
  conversation_ids: string[];
  running_children: number;
  total_children: number;
}
export interface RootConversation {
  id: string; type?: string; name?: string | null; kit_name?: string | null;
  project?: string | null; repository_id?: string | null; created_ts?: string | null;
  last_activity_ts?: string | null; state?: string;
}
interface RootRelation { from_id?: string; to_id?: string; type?: string; active?: boolean | number }

/** 継続とキット名で系列を作り、系列の外から子になっている会話を根から除く。 */
export function projectRoots(conversations: readonly RootConversation[], relations: readonly RootRelation[]): RootProjection[] {
  const rows = new Map(conversations.map(row => [row.id, row]));
  const parents = new Map(conversations.map(row => [row.id, row.id]));
  function find(id: string): string {
    const parent = parents.get(id)!;
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  }
  function join(left: string, right: string): void {
    if (rows.has(left) && rows.has(right)) parents.set(find(right), find(left));
  }
  const names = new Map<string, string>();
  for (const row of conversations) {
    if (!row.kit_name) continue;
    const key = JSON.stringify([row.project ?? row.repository_id ?? null, row.kit_name]);
    const previous = names.get(key);
    if (previous) join(previous, row.id);
    else names.set(key, row.id);
  }
  const active = relations.filter(row => row.active !== false && row.active !== 0 && row.from_id && row.to_id);
  for (const row of active) if (row.type === 'continued' || row.type === 'compacted') join(row.from_id!, row.to_id!);
  const groups = new Map<string, RootConversation[]>();
  for (const row of conversations) {
    const key = find(row.id);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const children = new Map<string, Set<string>>();
  for (const row of active) {
    if (row.type !== 'delegated') continue;
    const ids = children.get(row.from_id!) ?? new Set<string>();
    ids.add(row.to_id!); children.set(row.from_id!, ids);
  }
  const roots: RootProjection[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map(row => row.id));
    if (!group.some(row => row.type === 'interactive') || active.some(row => ids.has(row.to_id!) && !ids.has(row.from_id!))) continue;
    group.sort((a, b) => (a.created_ts ?? '').localeCompare(b.created_ts ?? '') || a.id.localeCompare(b.id));
    const first = group[0];
    const reached = new Set(ids);
    const queue = [...ids];
    for (const id of queue) for (const child of children.get(id) ?? []) {
      if (reached.has(child)) continue;
      reached.add(child); queue.push(child);
      if (rows.has(child)) for (const peer of groups.get(find(child)) ?? []) {
        if (!reached.has(peer.id)) { reached.add(peer.id); queue.push(peer.id); }
      }
    }
    const descendants = [...reached].filter(id => !ids.has(id) && rows.has(id)).map(id => rows.get(id)!);
    const latest = [...group].sort((a, b) => (b.last_activity_ts ?? b.created_ts ?? '').localeCompare(a.last_activity_ts ?? a.created_ts ?? '') || b.id.localeCompare(a.id))[0];
    const activity = [...group, ...descendants].flatMap(row => row.last_activity_ts ? [row.last_activity_ts] : row.created_ts ? [row.created_ts] : []).sort().at(-1) ?? null;
    roots.push({ id: first.id, name: group.find(row => row.kit_name)?.kit_name ?? first.name ?? first.id,
      project: first.project ?? first.repository_id ?? null, state: latest.state ?? 'unknown', last_activity_ts: activity,
      conversation_ids: group.map(row => row.id), running_children: descendants.filter(row => row.state === 'running').length,
      total_children: descendants.length });
  }
  return roots.sort((a, b) => a.id.localeCompare(b.id));
}

export function connectRootDelegations<T extends { root_id?: string | null; repository_id?: string; kit?: unknown }>(delegations: T[], roots: readonly RootProjection[]): (T & { root_id: string | null })[] {
  return delegations.map(row => {
    const kit = row.kit as { session?: unknown } | undefined;
    const matches = typeof kit?.session === 'string' ? roots.filter(root => root.name === kit.session
      && (!row.repository_id || root.project === null || root.project === row.repository_id)) : [];
    return { ...row, root_id: matches.length === 1 ? matches[0].id : null };
  });
}
