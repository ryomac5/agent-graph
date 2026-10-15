export type Confidence = "confirmed" | "inferred" | "unknown";
export type Stage = "launched" | "responded" | "reported" | "verified" | "reviewed";
export type ProcessState = "alive_confirmed" | "exited_confirmed" | "unverified";
export type HostingState = "hosted" | "not_hosted" | "unknown";
export type ClosureState = "open" | "closed" | "unknown";
export type TurnState = "running" | "waiting_approval" | "waiting_input" | "completed" | "unknown";
export type ResultState = "incomplete" | "succeeded" | "failed" | "interrupted" | "unknown" | "not_applicable";
export type Reason =
  | "missing_evidence" | "identity_unresolved" | "process_observed" | "process_exited"
  | "liveness_expired" | "scan_failed" | "scan_expired" | "scan_succeeded" | "out_of_scope"
  | "hosting_observed" | "run_opened" | "run_closed" | "turn_progress" | "running_tool" | "turn_finished"
  | "approval_requested" | "input_requested" | "progress_expired" | "waiting_expired"
  | "boundary_unavailable" | "evidence_conflict" | "history_conflict" | "unsupported_evidence"
  | "required_stage_unknown" | "stage_reached" | "stage_missing" | "attempt_failed"
  | "attempt_interrupted" | "not_applicable" | "accepted" | "emitting" | "emitted"
  | "not_emitted" | "aborted_after_write" | "owner_restarted" | "delivery_expired"
  | "correlated_receipt" | "unique_candidate" | "ambiguous_candidates" | "terminal_handled"
  | "cmd_id_conflict" | "unsupported_correlation";

// 時刻は UTC の epoch milliseconds。at は出来事／照会完了、observedAt は取得時刻。
export interface Evidence {
  id: string;
  at: number;
  observedAt: number;
  supersedes?: readonly string[];
}
export interface Decision<T> {
  value: T;
  confidence: Confidence;
  reason: Reason;
  at: number | null;
  validUntil: number | null;
  evidenceIds: string[];
}
export interface ProcessIdentity { pid: number; procStart: string }
export interface Scan extends Evidence {
  kind: "scan";
  source: string;
  scope: string;
  subjects: readonly string[];
  status: "succeeded" | "failed" | "partial";
  validForMs: number;
  processes?: readonly { pid: number; procStart: string | null }[];
  hosted?: readonly string[];
}
export interface Signal extends Evidence {
  kind: "signal";
  runId: string;
  turnId?: string | null;
  attemptId?: string | null;
  event: "start" | "progress" | "approval" | "input" | "complete" | "stop_attempt"
    | "open" | "close" | "archive" | "exit" | "interrupt_request" | "failure"
    | "interrupted" | "report_failure" | Stage;
  process?: ProcessIdentity;
  tools?: readonly { id: string | null; phase: "started" | "finished" }[];
  activity?: "session_busy";
  interruptId?: string;
  confidence?: "confirmed" | "inferred";
}
export interface Conflict extends Evidence {
  kind: "conflict";
  runId: string;
  count: number;
}
export interface Unavailable extends Evidence {
  kind: "unavailable";
  runId: string;
}
export type StateEvidence = Signal | Scan | Conflict | Unavailable;
export interface StateInput {
  // 対応済みの対象を呼び出し側から受け取る。同一性をここで推定しない。
  runId: string | null;
  turnId: string | null;
  process: ProcessIdentity | null;
  // 親の起動時の組を固定する。省略・null は未確認、独立した実行だけ明示する。
  parentProcessAtLaunch?: Readonly<ProcessIdentity> | "independent" | null;
  attempt: { id: string | null; requiredStage: Stage | "unknown" } | null;
  evidence: readonly StateEvidence[];
}
export interface StatePolicy { progressMs: number; waitingMs: number }
export const DEFAULT_STATE_POLICY: Readonly<StatePolicy> = Object.freeze({ progressMs: 300_000, waitingMs: 300_000 });
export interface StateDecision {
  evaluatedAt: number;
  process: Decision<ProcessState>;
  hosting: Decision<HostingState>;
  closure: Decision<ClosureState>;
  turn: Decision<TurnState>;
  result: Decision<ResultState> & { attemptId: string | null; requiredStage: Stage | "unknown" | null; stages: Stage[]; stage: Stage | null; reportFailures: string[] };
  observation: { source: string; scope: string; state: "healthy" | "failed" | "delayed"; at: number }[];
  conflicts: string[];
  display: { label: "Unresolved" | "Stopped" | "Needs approval" | "Waiting" | "Working" | "Closed" | "Not hosted" | "Idle" | "Unknown"; details: string[]; result: "Done" | "Failed" | "Interrupted" | "No result" | null };
}
