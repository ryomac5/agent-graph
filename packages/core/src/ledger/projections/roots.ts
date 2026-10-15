export interface RootProjection {
  id: string;
  name: string;
  auto_name?: string;
  user_name?: string | null;
  project: string | null;
  state: string;
  last_activity_ts: string | null;
  conversation_ids: string[];
  current_conversation_id: string;
  running_children: number;
  total_children: number;
}
export interface RootConversation {
  hidden?: boolean;
  user_name?: string | null;
  id: string; type?: string; name?: string | null; kit_name?: string | null;
  project?: string | null; repository_id?: string | null; created_ts?: string | null;
  last_activity_ts?: string | null; state?: string;
}
interface RootRelation { from_id?: string; to_id?: string; type?: string; active?: boolean | number; confidence?: string }

/** 確定した継続・対話の分岐と根のキット名で系列を作り、子の会話を同名の根に混ぜない。 */
export function projectRoots(conversations: readonly RootConversation[], relations: readonly RootRelation[]): RootProjection[] {
  const hidden = new Set(conversations.filter(row => row.hidden).map(row => row.id));
  conversations = conversations.filter(row => !row.hidden);
  relations = relations.filter(row => !hidden.has(row.from_id ?? '') && !hidden.has(row.to_id ?? ''));
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
  const active = relations.filter(row => row.active !== false && row.active !== 0 && row.from_id && row.to_id);
  for (const row of active) if (row.type === 'continued' && row.confidence === 'confirmed'
    && rows.get(row.from_id!)?.type === 'interactive' && rows.get(row.to_id!)?.type === 'interactive') join(row.from_id!, row.to_id!);
  // sdk-cli は unattended、native の子は subagent、親付き委譲は delegated の終点、審査役は review_of の始点として記録される。
  const childGroups = new Set(conversations.filter(row => row.type !== 'interactive').map(row => find(row.id)));
  for (const row of active) {
    const child = row.type === 'delegated' ? row.to_id : row.type === 'review_of' ? row.from_id : undefined;
    if (child && rows.has(child)) childGroups.add(find(child));
  }
  const forks = active.filter(row => row.type === 'forked' && row.confidence === 'confirmed');
  for (const group of childGroups) for (const row of forks) {
    if (rows.has(row.from_id!) && rows.has(row.to_id!)
      && find(row.from_id!) === group) childGroups.add(find(row.to_id!));
  }
  // 利用者の対話の分岐は同じ根を継ぐ。子と審査役の系列は分岐でも根に混ぜない。
  for (const row of forks) if (rows.get(row.from_id!)?.type === 'interactive' && rows.get(row.to_id!)?.type === 'interactive'
    && !childGroups.has(find(row.from_id!)) && !childGroups.has(find(row.to_id!))) join(row.from_id!, row.to_id!);
  const names = new Map<string, string>();
  for (const row of conversations) {
    if (!row.kit_name || childGroups.has(find(row.id))) continue;
    const key = JSON.stringify([row.project ?? row.repository_id ?? null, row.kit_name]);
    const previous = names.get(key);
    if (previous) join(previous, row.id);
    else names.set(key, row.id);
  }
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
  // キットのあるプロジェクトでは、名前のある対話の系列だけを根にする。
  const kitProjects = new Set(conversations.filter(row => row.kit_name).map(row => row.project ?? row.repository_id ?? null));
  const roots: RootProjection[] = [];
  for (const group of groups.values()) {
    const ids = new Set(group.map(row => row.id));
    if (!group.some(row => row.type === 'interactive') || active.some(row => row.type !== 'review_of'
      && (row.type === 'delegated' || row.confidence === 'confirmed') && ids.has(row.to_id!) && !ids.has(row.from_id!))
      || active.some(row => row.type === 'review_of' && ids.has(row.from_id!))) continue;
    const project = group[0].project ?? group[0].repository_id ?? null;
    if (kitProjects.has(project) && !group.some(row => row.kit_name)) continue;
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
    const rank = (row: RootConversation) => ["waiting_approval", "waiting_input"].includes(row.state ?? "") ? 2
      : ["starting", "running"].includes(row.state ?? "") ? 1 : 0;
    const latest = [...group].sort((a, b) => rank(b) - rank(a) || (b.last_activity_ts ?? b.created_ts ?? '').localeCompare(a.last_activity_ts ?? a.created_ts ?? '') || b.id.localeCompare(a.id))[0];
    const activity = [...group, ...descendants].flatMap(row => row.last_activity_ts ? [row.last_activity_ts] : row.created_ts ? [row.created_ts] : []).sort().at(-1) ?? null;
    const automatic = group.find(row => row.kit_name)?.kit_name ?? first.name ?? first.id;
    roots.push({ id: first.id, name: first.user_name || automatic,
      ...(first.user_name ? { user_name: first.user_name, auto_name: automatic } : {}),
      project: first.project ?? first.repository_id ?? null, state: latest.state ?? 'unknown', last_activity_ts: activity,
      conversation_ids: group.map(row => row.id), current_conversation_id: latest.id, running_children: descendants.filter(row => row.state === 'running').length,
      total_children: descendants.length });
  }
  return roots.sort((a, b) => a.id.localeCompare(b.id));
}

export function connectRootDelegations<T extends { root_id?: string | null; repository_id?: string; kit?: unknown }>(delegations: T[], roots: readonly RootProjection[]): (T & { root_id: string | null })[] {
  return delegations.map(row => {
    const kit = row.kit as { session?: unknown } | undefined;
    const matches = typeof kit?.session === 'string' ? roots.filter(root => (root.auto_name ?? root.name) === kit.session
      && (!row.repository_id || root.project === null || root.project === row.repository_id)) : [];
    return { ...row, root_id: matches.length === 1 ? matches[0].id : null };
  });
}
