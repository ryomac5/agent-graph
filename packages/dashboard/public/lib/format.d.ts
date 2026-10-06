export type StatusClass = "planned" | "running" | "waiting" | "done" | "failed" | "ended";

export interface NodeLike {
  id?: string;
  kind?: string;
  title?: string;
  role?: string;
  status?: string;
  executor?: string;
  model?: string;
  family?: string;
  client?: string;
  task?: string;
}

export interface FitResult {
  lines: string[];
  size: "" | "snug" | "tight";
}

export const STATUS_CLASS: Record<string, StatusClass>;
export const STATUS_LABEL: Record<string, string>;
export function statusClass(status: string | undefined): StatusClass;
export function statusLabel(status: string | undefined): string;
export function familyOf(node: NodeLike | undefined): "anthropic" | "openai" | "";
export function kindTitle(node: NodeLike | undefined): string;
export function roleLabel(node: NodeLike | undefined): string;
export function modelLabel(id: string | undefined): string;
export function fitWords(text: string | undefined, maxChars?: number): FitResult;
export function fmtWhen(value: string | Date | undefined, full?: boolean, now?: Date): string;
export function fmtUntil(value: string | Date | undefined, now?: Date): string;
export function fmtElapsed(started: string | undefined, ended?: string, now?: Date): string;
export function fmtTokens(tokens: { input?: number; output?: number } | undefined): string;
