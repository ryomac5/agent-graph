export interface GraphNode {
  id: string;
  kind: "session" | "delegation";
  title: string;
  role?: string;
  status?: string;
  executor?: string | null;
  model?: string | null;
  family?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  fromFamily?: string | null;
  toFamily?: string | null;
  title?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DelegationChange {
  node: GraphNode;
  edge?: GraphEdge;
}

export function applySnapshot(state: Graph, graph: Graph): Graph;
export function applyDelegation(state: Graph, change: DelegationChange): Graph;
export function layout(state: Graph): { nodes: { id: string; x: number; y: number }[] };
export function edgeDirection(edge: GraphEdge): "anthropic→openai" | "openai→anthropic" | "same" | "unknown";
