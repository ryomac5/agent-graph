import type { Ctx } from "./graph.js";
export interface HeaderState {
  projects: unknown[];
  selected: string[];
  counts: { running: number; waiting: number; failed: number; done: number };
  usage: unknown;
  connection: string;
  updatedAt: string;
}
export function renderUsage(doc: any, usage: unknown, now?: Date): void;
export function renderHeader(doc: any, state: HeaderState, ctx: Ctx): void;
