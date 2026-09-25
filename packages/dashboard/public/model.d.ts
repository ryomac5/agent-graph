export interface GraphNode {
  id: string;
  kind: "session" | "delegation";
  title: string;
  role?: string;
  status?: string;
  executor?: string;
  model?: string;
  family?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  fromFamily?: string;
  toFamily?: string;
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
