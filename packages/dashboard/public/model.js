export function applySnapshot(state, graph) {
  return {
    nodes: mergeById(state.nodes, graph.nodes),
    edges: mergeEdges(state.edges, graph.edges),
  };
}

export function applyDelegation(state, change) {
  return applySnapshot(state, {
    nodes: [change.node],
    edges: change.edge ? [change.edge] : [],
  });
}

function mergeById(current, incoming) {
  const items = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    items.set(item.id, { ...items.get(item.id), ...item });
  }
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function mergeEdges(current, incoming) {
  const key = (edge) => `${edge.from}\u0000${edge.to}`;
  const items = new Map(current.map((edge) => [key(edge), edge]));
  for (const edge of incoming) {
    items.set(key(edge), { ...items.get(key(edge)), ...edge });
  }
  return [...items.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

export function layout(state) {
  const ids = state.nodes.map((node) => node.id).sort();
  const known = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of state.edges) {
    if (known.has(edge.from) && known.has(edge.to)) {
      incoming.set(edge.to, incoming.get(edge.to) + 1);
      outgoing.get(edge.from).push(edge.to);
    }
  }
  const depth = new Map();
  const queue = ids.filter((id) => incoming.get(id) === 0);
  for (const id of queue) depth.set(id, 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const child of outgoing.get(id).sort()) {
      depth.set(child, Math.max(depth.get(child) ?? 0, depth.get(id) + 1));
      incoming.set(child, incoming.get(child) - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  // 循環がある場合も配置を確定させる。
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0);
  const columns = new Map();
  for (const id of ids) {
    const column = depth.get(id);
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(id);
  }
  return {
    nodes: [...columns.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([column, members]) => members.map((id, row) => ({
        id,
        x: 130 + column * 290,
        y: 90 + row * 150,
      }))),
  };
}

export function edgeDirection(edge) {
  if (!edge.fromFamily || !edge.toFamily) return "unknown";
  if (edge.fromFamily === edge.toFamily) return "same";
  if (edge.fromFamily === "anthropic" && edge.toFamily === "openai") return "anthropic→openai";
  if (edge.fromFamily === "openai" && edge.toFamily === "anthropic") return "openai→anthropic";
  return "unknown";
}
