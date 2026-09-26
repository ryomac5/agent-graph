// 描画の文脈。app.js が作り、テストでは小さな DOM と偽の関数を渡す
export interface Scope {
  id: string;
  kind: "session" | "planner";
  name: string;
  status: string;
  goal?: string;
  startedAt?: string;
  endedAt?: string;
  turns: unknown[];
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  sessionId?: string;
  graphId?: string;
  sessionName?: string;
}
export interface RenderContext {
  dismissed: Set<string>;
  expandedArchive: Set<string>;
  selectedScope: string | null;
  selectedNode: string | null;
  knownEdges: Map<string, Set<string>>;
  knownNodes: Map<string, Set<string>>;
  fresh: Map<string, number>;
  zoom: Map<string, { x: number; y: number; w: number; h: number }>;
  orbSlots: Map<string, unknown>;
  expandedRounds: Set<string>;
  hiddenTurns: Set<string>;
  factsOpen: { value: boolean };
  chatView: { key: string; top: number; stick: boolean };
  maxWidth: number;
  projectName: string;
  confirm: (text: string) => boolean;
  onOpen: (key: string | null, additive?: boolean) => void;
  onSelect: (scope: Scope, nodeId: string) => void;
  onToggleDismiss: (scope: Scope, nodeId: string) => void;
  onToggleArchive: (scope: Scope) => void;
  onAction: (body: Record<string, unknown>, nodeId?: string) => Promise<string>;
  onHideTurn: (scope: Scope, turnId: string) => void;
}
export type Ctx = RenderContext | Record<string, unknown>;
export function renderGraph(scope: Scope, ctx: Ctx): any;
export function directionWord(edge: { fromFamily?: string; toFamily?: string }, from?: unknown, to?: unknown): string;
