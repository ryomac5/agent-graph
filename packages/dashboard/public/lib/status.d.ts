export interface Counts { running: number; waiting: number; failed: number; done: number }
export type CountKey = keyof Counts;

export interface CountedNode { id: string; kind?: string; status?: string }
export interface CountedScope { id?: string; status?: string; nodes?: CountedNode[] }
export interface CountedView { sessions?: CountedScope[]; graphs?: CountedScope[] }
export interface OrbSummary { counts?: Partial<Counts>; liveSessions?: number; status?: string }
export interface OrbState { key: CountKey | ""; text: string; quiet: boolean }
export type ActionPair = [string, string];

export const ORB_PRIORITY: CountKey[];
export const STATE_TEXT: Record<CountKey, string>;
export const USAGE_WARN: number;
export const USAGE_HIGH: number;
export function isLive(session: { status?: string } | undefined): boolean;
export function countNodes(nodes: CountedNode[] | undefined, dismissed?: Set<string>, prefix?: string): Counts;
export function countProject(view: CountedView | undefined, dismissed?: Set<string>): Counts;
export function sumCounts(list: Partial<Counts>[] | undefined): Counts;
export function orbState(summary: OrbSummary, unavailable?: boolean): OrbState;
export function usageLevel(percent: number | undefined): "" | "warn" | "high";
export function actionsFor(node: { kind?: string; status?: string } | undefined): ActionPair[];
