export type Role = "orchestrate" | "implement" | "research" | "document" | "review";
export type Executor = "claude" | "codex";
export type ModelFamily = "anthropic" | "openai";
export type Tier = "high" | "mid" | "low";

export interface Candidate {
  executor: Executor;
  model: string;
  family: ModelFamily;
  tier: Tier;
}

export interface Assignment extends Candidate {
  reason: string[];
  policyVersion: string;
}

export interface DelegateRequest {
  role: Role;
  title: string;
  task: string;
  accept: string[];
  scope?: string[];
  outputs?: string[];
  cwd?: string;
  constraints?: {
    excludeFamily?: ModelFamily[];
    excludeModels?: string[];
    minTier?: Tier;
  };
  timeoutSec?: number;
  review?: boolean;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AcceptanceResult {
  passed: boolean;
  results: { command: string; exitCode: number; output: string; durationMs: number }[];
  scopeViolations: string[];
}

export interface ReviewResult {
  verdict: "approve" | "request_changes";
  reviewer: Assignment;
  comment: string;
}

export interface DelegateResult {
  delegationId: string;
  traceId: string;
  spanId: string;
  status: "done" | "failed" | "timeout" | "denied";
  assignment: Assignment;
  output: string;
  acceptance: AcceptanceResult;
  review?: ReviewResult;
  usage: TokenUsage;
  roundTrips: number;
}
