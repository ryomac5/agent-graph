import type { Ctx, Scope } from "./graph.js";
export function sessionScope(session: Record<string, unknown>): Scope;
export function graphScope(graph: Record<string, unknown>, sessions?: Record<string, unknown>[]): Scope;
export function buildProjectSection(view: Record<string, unknown>, ctx: Ctx): any;
export function scopesOf(view: Record<string, unknown> | undefined): Scope[];
