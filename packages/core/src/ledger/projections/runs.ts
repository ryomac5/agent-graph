import type { Fact, JsonValue, RunPayload } from "../facts.ts";
import { orderActiveFacts } from "./connections.ts";

// ホストと観測側は、この構造を end_evidence に正規化して追記する。
export type EndEvidence =
  | { kind: "host_exit"; exit_code: number; turn_id?: string; subtype?: string; is_error?: boolean }
  | { kind: "thread_closed" }
  | { kind: "session_end"; generation: number }
  | { kind: "archived"; location: "archived_sessions" }
  | { kind: "process_check"; succeeded: boolean; matches: boolean; pid: number; start_fingerprint: string }
  | { kind: "user_correction" };

export interface RunProjection extends RunPayload { id: string }

function readObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function confirmEnd(fact: Fact, run: RunProjection, evidence: { [key: string]: JsonValue }): boolean {
  if (fact.confidence !== "confirmed") return false;
  switch (evidence.kind) {
    case "host_exit": return (fact.source === "host-claude" || fact.source === "host-codex")
      && typeof evidence.exit_code === "number" && Number.isInteger(evidence.exit_code);
    case "thread_closed": return fact.source === "host-codex";
    case "session_end": return fact.source === "hook" && evidence.generation === run.generation;
    case "archived": return fact.source === "rollout-codex" && evidence.location === "archived_sessions";
    case "process_check": return evidence.succeeded === true && evidence.matches === false
      && run.pid !== undefined && run.start_fingerprint !== undefined
      && evidence.pid === run.pid && evidence.start_fingerprint === run.start_fingerprint;
    case "user_correction": return fact.source === "ui";
    default: return false;
  }
}

/** 各世代は独立した run subject を使う。同じ subject の再登録も世代別に分離する。 */
export function projectRuns(facts: readonly Fact[]): RunProjection[] {
  const runs = new Map<string, RunProjection>();
  const currentGeneration = new Map<string, number>();
  const interruptedTurns = new Set<string>();
  const active = orderActiveFacts(facts);
  for (const fact of active) {
    if (!fact.kind.startsWith("run.") || !fact.payload) continue;
    const subjectId = fact.subject.slice("run:".length);
    const payload = fact.payload as Partial<RunPayload> & { turn_id?: string };
    const generation = payload.generation ?? currentGeneration.get(subjectId);
    if (generation === undefined) continue;
    const key = JSON.stringify([subjectId, generation]);
    if (fact.kind === "run.created") currentGeneration.set(subjectId, generation);
    if (fact.kind === "run.interrupt_requested") {
      if (payload.turn_id && fact.confidence === "confirmed") interruptedTurns.add(JSON.stringify([key, payload.turn_id]));
      continue;
    }
    const previous = runs.get(key);
    const conversationId = payload.conversation_id ?? previous?.conversation_id;
    if (!conversationId) continue;
    const run: RunProjection = previous ? { ...previous } : {
      id: `${conversationId}:${generation}`, conversation_id: conversationId, generation, state: "unknown",
      reason: "missing_state_evidence",
    };
    for (const field of ["started_ts", "base_sha", "pid", "start_fingerprint", "repository_id", "worktree_id"] as const) {
      const value = payload[field];
      if (value !== undefined) Object.assign(run, { [field]: value });
    }
    const evidence = readObject(payload.end_evidence);
    const terminal = run.state === "ended" || run.state === "failed";
    if (payload.state && !terminal) {
      if (payload.state === "ended" || payload.state === "failed") {
        if (evidence && confirmEnd(fact, run, evidence)) {
          const interrupted = fact.source === "host-claude" && evidence.kind === "host_exit"
            && typeof evidence.turn_id === "string"
            && interruptedTurns.has(JSON.stringify([key, evidence.turn_id]))
            && (evidence.exit_code === 1
              || (evidence.is_error === true && evidence.subtype === "error_during_execution"));
          run.state = interrupted ? "ended" : payload.state;
          if (run.state === "failed" && !payload.cause) {
            run.state = "unknown";
            run.reason = "missing_failure_cause";
          } else {
            run.end_evidence = interrupted ? { ...evidence, interrupted: true } : { ...evidence };
            run.ended_ts = payload.ended_ts ?? fact.source_ts;
            if (run.state === "failed") run.cause = payload.cause;
            delete run.reason;
            run.last_evidence = { fact_id: fact.fact_id, kind: fact.kind };
            run.last_evidence_ts = fact.source_ts;
          }
        } else {
          run.state = "unknown";
          run.reason = payload.reason ?? "unconfirmed_end_evidence";
        }
      } else if (payload.state === "unknown" || fact.confidence !== "confirmed") {
        run.state = "unknown";
        run.reason = payload.reason ?? "unconfirmed_state_evidence";
      } else {
        run.state = payload.state;
        run.last_evidence = payload.last_evidence ?? { fact_id: fact.fact_id, kind: fact.kind };
        run.last_evidence_ts = payload.last_evidence_ts ?? fact.source_ts;
        delete run.reason;
      }
    }
    // 根拠がまだ無い場合にも、観測した事実と時刻を残す。
    run.last_evidence ??= { fact_id: fact.fact_id, kind: fact.kind };
    run.last_evidence_ts ??= fact.source_ts;
    runs.set(key, run);
  }
  return [...runs.values()]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
