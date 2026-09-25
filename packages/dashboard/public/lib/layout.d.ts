export interface LayoutNode { id: string; kind?: string }
export interface LayoutEdge { id?: string; from: string; to: string; kind?: string }
export interface LayoutView { nodes: LayoutNode[]; edges: LayoutEdge[] }
export interface Box { x: number; y: number; w: number; h: number }
export interface Layout { pos: Map<string, Box>; edges: LayoutEdge[]; width: number; height: number; rows: string[][] }

export const ROOT_D: number;
export const CHILD_D: number;
export const GRAPH_COL: number;
export const GRAPH_ROW: number;
export const GRAPH_SUBROW: number;
export const GRAPH_PAD: number;
export const CHIP_W: number;
export const CHIP_H: number;
export const CHIP_GAP: number;
export const BACK_BULGE: number;
export const ARCHIVE_ID: string;
export function nodeBox(node: LayoutNode): { w: number; h: number };
export function isForward(edge: LayoutEdge): boolean;
export function edgeCurve(x1: number, y1: number, x2: number, y2: number, bulge?: number): string;
export function edgeMid(x1: number, y1: number, x2: number, y2: number, bulge?: number): { x: number; y: number };
export function edgePoint(x1: number, y1: number, x2: number, y2: number, bulge?: number, t?: number): { x: number; y: number };
export function depthsOf(nodes: LayoutNode[], edges: LayoutEdge[]): { depth: Map<string, number>; forward: LayoutEdge[] };
export function layoutGraph(view: LayoutView, options?: { maxWidth?: number }): Layout;
export function backBulge(x1: number, x2: number, width: number): number;
export function fitScale(width: number, height: number, boxWidth: number, boxHeight?: number, min?: number): number;
