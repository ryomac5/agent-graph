export interface VisibleNode { id: string; kind?: string; status?: string; startedAt?: string; title?: string; count?: number }
export interface VisibleEdge { id?: string; from: string; to: string; kind?: string; label?: string }
export interface VisibleScope { id: string; nodes?: VisibleNode[]; edges?: VisibleEdge[]; turns?: { at?: string }[] }
export interface VisibleResult { nodes: VisibleNode[]; edges: VisibleEdge[]; archived: number; expanded: boolean; hidden: Set<string> }

export const DISMISSABLE_STATUS: Set<string>;
export function isDismissable(node: VisibleNode | undefined): boolean;
export function dismissKey(scopeId: string, nodeId: string): string;
export function visibleView(scope: VisibleScope, dismissed?: Set<string>, expanded?: boolean): VisibleResult;
export function diffKnown(known: Set<string> | undefined, ids: string[]): { known: Set<string>; fresh: Set<string> };
