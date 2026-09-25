import type { TraceContext } from "./trace.ts";

export type EventKind =
  | "session.started"
  | "delegation.requested"
  | "assignment.decided"
  | "execution.started"
  | "execution.finished"
  | "acceptance.evaluated"
  | "review.evaluated"
  | "delegation.finished"
  | "usage.sampled"
  | "guard.denied";

// 仮: payload の構造は設計書に未定義のため、各イベントの最小必須項目に留める。
export interface EventPayload {
  "session.started": { sessionId: string };
  "delegation.requested": { delegationId: string; task: string };
  "assignment.decided": { delegationId: string; executor: "claude" | "codex"; model: string; reason: string[]; policyVersion: string };
  "execution.started": { delegationId: string };
  "execution.finished": { delegationId: string; exitCode: number };
  "acceptance.evaluated": { delegationId: string; passed: boolean };
  "review.evaluated": { delegationId: string; verdict: "approve" | "request_changes" };
  "delegation.finished": { delegationId: string; status: "done" | "failed" | "timeout" | "denied" };
  "usage.sampled": { provider: string; window: string; percent: number; model?: string };
  "guard.denied": { command: string; reason: string };
}

export interface Event<K extends EventKind = EventKind> {
  id: string;
  ts: string;
  kind: K;
  repo: string;
  session?: string;
  trace: TraceContext;
  payload: EventPayload[K];
}

export interface Span {
  trace: TraceContext;
  name: string;
  startedAt: string;
  endedAt?: string;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string | number | boolean> & {
    "agent.role": string;
    "agent.executor": string;
    "agent.model": string;
    "agent.session": string;
    "agent.delegation": string;
  };
}
