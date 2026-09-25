import type { Ctx, Scope } from "./graph.js";
export function buildBubble(round: { role: string; text: string; at?: string }, tone: string, key: string, ctx: Ctx): any;
export function renderRootDetail(aside: any, scope: Scope, ctx: Ctx): void;
export function renderNodeDetail(aside: any, scope: Scope, node: Record<string, unknown>, ctx: Ctx): void;
export function renderDetail(aside: any, scope: Scope | null, nodeId: string | null, ctx: Ctx): void;
