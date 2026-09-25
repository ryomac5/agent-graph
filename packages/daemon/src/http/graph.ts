import type { DatabaseSync } from "node:sqlite";

export interface GraphNode {
  id: string;
  kind: "session" | "delegation";
  title: string;
  role: string;
  status: string;
  executor: string | null;
  model: string | null;
  family: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  fromFamily: string | null;
  toFamily: string | null;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraph(db: DatabaseSync, options: { session?: string } = {}): Graph {
  const sessions = options.session === undefined
    ? db.prepare("SELECT id, name, client, started_at FROM sessions ORDER BY started_at, id").all()
    : db.prepare("SELECT id, name, client, started_at FROM sessions WHERE id = ?").all(options.session);
  const delegations = options.session === undefined
    ? db.prepare(`SELECT d.*, a.executor, a.model, a.family FROM delegations d
      LEFT JOIN assignments a ON a.delegation_id = d.id ORDER BY d.rowid`).all()
    : db.prepare(`SELECT d.*, a.executor, a.model, a.family FROM delegations d
      LEFT JOIN assignments a ON a.delegation_id = d.id WHERE d.session_id = ? ORDER BY d.rowid`).all(options.session);
  const nodes: GraphNode[] = sessions.map((row) => ({
    id: String(row.id), kind: "session", title: String(row.name), role: "root", status: "running",
    executor: String(row.client), model: null, family: row.client === "claude" ? "anthropic" : row.client === "codex" ? "openai" : null,
    startedAt: String(row.started_at), endedAt: null,
  }));
  const family = new Map<string, string | null>(nodes.map((node) => [node.id, node.family]));
  const edges: GraphEdge[] = [];
  const eventTime = db.prepare(`SELECT ts FROM events WHERE kind = ? AND json_extract(payload, '$.delegationId') = ?
    ORDER BY ts LIMIT 1`);
  for (const row of delegations) {
    const id = String(row.id);
    const node: GraphNode = {
      id, kind: "delegation", title: String(row.title), role: String(row.role), status: String(row.status),
      executor: row.executor === null ? null : String(row.executor),
      model: row.model === null ? null : String(row.model),
      family: row.family === null ? null : String(row.family),
      startedAt: (eventTime.get("delegation.requested", id)?.ts as string | undefined) ?? null,
      endedAt: (eventTime.get("delegation.finished", id)?.ts as string | undefined) ?? null,
    };
    nodes.push(node);
    family.set(id, node.family);
  }
  for (const row of delegations) {
    const from = String(row.parent_id ?? row.session_id);
    if (!family.has(from)) continue;
    edges.push({ from, to: String(row.id), fromFamily: family.get(from) ?? null,
      toFamily: family.get(String(row.id)) ?? null });
  }
  return { nodes, edges };
}

export function diffGraph(previous: Graph, next: Graph): { node: GraphNode; edge?: GraphEdge }[] {
  const nodes = new Map(previous.nodes.map((node) => [node.id, JSON.stringify(node)]));
  const edges = new Map(previous.edges.map((edge) => [edge.to, JSON.stringify(edge)]));
  const incoming = new Map(next.edges.map((edge) => [edge.to, edge]));
  return next.nodes.flatMap((node) => {
    const edge = incoming.get(node.id);
    if (nodes.get(node.id) === JSON.stringify(node) && edges.get(node.id) === JSON.stringify(edge)) return [];
    return [{ node, ...(edge ? { edge } : {}) }];
  });
}
