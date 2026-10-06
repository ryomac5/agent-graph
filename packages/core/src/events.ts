import type { TraceContext } from "./trace.ts";

export type EventKind =
  | "session.started"
  | "session.forked"
  | "session.named"
  | "delegation.requested"
  | "assignment.decided"
  | "execution.started"
  | "execution.finished"
  | "acceptance.evaluated"
  | "review.evaluated"
  | "delegation.finished"
  | "delegation.lost"
  | "usage.sampled"
  | "guard.denied";

// 仮: payload の構造は設計書に未定義のため、各イベントの最小必須項目に留める。
export interface EventPayload {
  "session.started": { sessionId: string };
  // --fork-session で起きた会話の親。番号を付けるときに親の番号を継ぐ
  "session.forked": { sessionId: string; parentSessionId: string };
  // 番号を付けた。reason は最初の人の指示か、片割れから移した由来。fork なら forkOf に親を残す
  "session.named": { sessionId: string; name: string; reason: "first_prompt" | `merged from ${string}`; forkOf?: string };
  "delegation.requested": { delegationId: string; task: string };
  "assignment.decided": { delegationId: string; executor: "claude" | "codex"; model: string; reason: string[]; policyVersion: string };
  "execution.started": { delegationId: string };
  "execution.finished": { delegationId: string; exitCode: number };
  "acceptance.evaluated": { delegationId: string; passed: boolean };
  "review.evaluated": { delegationId: string; verdict: "approve" | "request_changes" };
  "delegation.finished": { delegationId: string; status: "done" | "failed" | "timeout" | "denied" };
  // 親セッションの終了で失われた。あとで実際に完了すれば finished が事実として上書きする
  "delegation.lost": { delegationId: string; reason: string };
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
