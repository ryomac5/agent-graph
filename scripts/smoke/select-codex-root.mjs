/** Codex の子孫を持つ根のうち子が最多のものを選ぶ。なければ従来の順位に戻す。 */
export function selectCodexRoot(snapshot, projectId, smokeId) {
  const { projection, identities } = snapshot;
  const canonical = id => identities?.conversations?.[id] ?? id;
  const roots = projection.roots.filter(root => root.project === projectId && root.id !== smokeId)
    .toSorted((a, b) => (b.total_children ?? 0) - (a.total_children ?? 0));
  const codex = new Set((projection.conversations ?? []).filter(row => row.provider === 'codex').map(row => canonical(row.id)));
  const children = new Map();
  for (const relation of projection.relations ?? []) {
    if (relation.active === 0 || relation.active === false) continue;
    // snapshot で省略された関係の欄は、組の ID から復元する。
    const parts = relation.id?.startsWith('[') ? JSON.parse(relation.id) : [];
    if ((relation.type ?? parts[0]) !== 'delegated') continue;
    const from = canonical(relation.from_id ?? parts[1]);
    const to = canonical(relation.to_id ?? parts[2]);
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
  }
  return roots.find(root => {
    const visited = new Set(root.conversation_ids.map(canonical));
    const queue = [...visited];
    for (const id of queue) for (const child of children.get(id) ?? []) {
      if (visited.has(child)) continue;
      if (codex.has(child) || child?.startsWith('["codex",')) return true;
      visited.add(child);
      queue.push(child);
    }
    return false;
  }) ?? roots[0];
}
