import { createHash } from "node:crypto";
import type { DelegateRequest, DelegateResult } from "../delegate/types.ts";
import type { JsonValue } from "../ledger/facts.ts";
import { serializeValue } from "../ledger/projections/relations.ts";

export interface IntakeRequest extends DelegateRequest {
  requestId: string;
  source: "ui" | "mcp" | "planner" | "kit";
  parentRun?: string;
  origin?: { provider: "claude" | "codex"; nativeId: string };
}
export interface IntakeStatus {
  requestId: string;
  state: "received" | "accepted" | "assigned" | "running" | "verifying" | "reviewing" | "done" | "failed" | "interrupted" | "denied";
  attempt: number;
  result?: DelegateResult;
  reason?: string;
}
export type RequestIdentity =
  | { source: "ui"; cmdId: string }
  | { source: "mcp"; callId: string }
  | { source: "planner"; graphId: string; taskId: string; attempt: number }
  | { source: "kit"; file: string; position: number };

export function createRequestId(identity: RequestIdentity): string {
  const parts = identity.source === "ui" ? [identity.cmdId]
    : identity.source === "mcp" ? [identity.callId]
    : identity.source === "planner" ? [identity.graphId, identity.taskId, identity.attempt]
    : [identity.file, identity.position];
  if (parts.some((part) => typeof part === "string" ? !part : !Number.isSafeInteger(part) || part < (identity.source === "planner" ? 1 : 0))) {
    throw new TypeError("Invalid request identity");
  }
  return `${identity.source}:${JSON.stringify(parts)}`;
}
export function fingerprintRequest(request: IntakeRequest): string {
  return createHash("sha256").update(serializeValue(JSON.parse(JSON.stringify(request)) as JsonValue)).digest("hex");
}
export function conflictsWithRequest(left: IntakeRequest, right: IntakeRequest): boolean {
  return left.requestId === right.requestId && fingerprintRequest(left) !== fingerprintRequest(right);
}
const TRANSITIONS: Record<IntakeStatus["state"], readonly IntakeStatus["state"][]> = {
  received: ["accepted", "denied"], accepted: ["assigned", "denied", "failed", "interrupted"],
  assigned: ["running", "failed", "interrupted"], running: ["verifying", "failed", "interrupted"],
  verifying: ["reviewing", "failed", "interrupted"], reviewing: ["done", "failed", "interrupted", "denied"],
  done: [], failed: [], interrupted: [], denied: [],
};
export function isTerminalState(state: IntakeStatus["state"]): boolean { return TRANSITIONS[state].length === 0; }
export function transitionStatus(status: IntakeStatus, state: IntakeStatus["state"]): IntakeStatus {
  if (!TRANSITIONS[status.state].includes(state)) throw new Error(`Invalid intake transition: ${status.state} -> ${state}`);
  return { ...status, state };
}
export function retryStatus(status: IntakeStatus): IntakeStatus {
  if (!["failed", "interrupted", "denied"].includes(status.state)) throw new Error("Delegation is not retryable");
  return { requestId: status.requestId, state: "accepted", attempt: status.attempt + 1 };
}
export function readOrigin(env: Record<string, string | undefined>, provider?: "claude" | "codex"): Pick<IntakeRequest, "parentRun" | "origin"> {
  if (env.AGENT_GRAPH_MANAGED) return { parentRun: env.AGENT_GRAPH_MANAGED };
  const claude = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID;
  if (claude && codex && !provider) return {};
  if (claude && (!codex || provider === "claude")) return { origin: { provider: "claude", nativeId: claude } };
  if (codex && (!claude || provider === "codex")) return { origin: { provider: "codex", nativeId: codex } };
  return {};
}
export function validateRequest(value: unknown): asserts value is IntakeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid intake request");
  const r = value as IntakeRequest;
  for (const field of ["requestId", "title", "task"] as const) if (typeof r[field] !== "string" || !r[field]) throw new TypeError(`Invalid ${field}`);
  if (!["ui", "mcp", "planner", "kit"].includes(r.source)) throw new TypeError("Invalid source");
  if (!["implement", "review", "research", "document", "orchestrate"].includes(r.role)) throw new TypeError("Invalid role");
  for (const field of ["accept", "scope", "outputs"] as const) {
    if ((field === "accept" || r[field] !== undefined) && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw new TypeError(`Invalid ${field}`);
  }
  for (const field of ["cwd", "parentRun"] as const) if (r[field] !== undefined && (typeof r[field] !== "string" || !r[field])) throw new TypeError(`Invalid ${field}`);
  if (r.origin !== undefined && (!r.origin || !["claude", "codex"].includes(r.origin.provider) || typeof r.origin.nativeId !== "string" || !r.origin.nativeId)) throw new TypeError("Invalid origin");
  if (r.timeoutSec !== undefined && (!Number.isFinite(r.timeoutSec) || r.timeoutSec <= 0)) throw new TypeError("Invalid timeoutSec");
  if (r.constraints !== undefined) {
    const c = r.constraints;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new TypeError("Invalid constraints");
    if (c.excludeFamily !== undefined && (!Array.isArray(c.excludeFamily) || !c.excludeFamily.every((v) => ["openai", "anthropic"].includes(v)))) throw new TypeError("Invalid excludeFamily");
    if (c.excludeModels !== undefined && (!Array.isArray(c.excludeModels) || !c.excludeModels.every((v) => typeof v === "string"))) throw new TypeError("Invalid excludeModels");
    if (c.minTier !== undefined && !["low", "mid", "high"].includes(c.minTier)) throw new TypeError("Invalid minTier");
  }
}
