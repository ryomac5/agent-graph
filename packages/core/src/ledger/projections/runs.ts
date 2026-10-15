import type { Fact, RunPayload } from "../facts.ts";
import type { JsonValue } from "../facts.ts";
import { orderActiveFacts } from "./connections.ts";
import { normalizeTimestampFields } from "../timestamps.ts";

// ホストと観測側は、この構造を end_evidence に正規化して追記する。
export type EndEvidence =
  | { kind: "host_exit"; exit_code: number; turn_id?: string; subtype?: string; is_error?: boolean }
  | { kind: "thread_closed" }
  | { kind: "session_end"; generation: number }
  | { kind: "archived"; location: "archived_sessions" }
  | { kind: "process_check"; succeeded: boolean; matches: boolean; pid: number; start_fingerprint: string }
  | { kind: "user_correction" }
  | { kind: "legacy_delegation"; table: "delegations"; id: string; status: "done" | "failed" };

// launch は runner が記録する起動の設定で、cwd と model と effort を持つ。
export interface RunProjection extends RunPayload { id: string; launch?: JsonValue }


/** 台帳に記録された属性だけを投影する。現在の状態の評価は api が行う。 */
export function projectRuns(facts: readonly Fact[]): RunProjection[] {
  return projectRunHistory(facts).runs;
}

export function projectRunHistory(facts: readonly Fact[]): {
  runs: RunProjection[]; ends: { conversation_id: string; ended_ts: string }[];
} {
  const runs = new Map<string, RunProjection>();
  const generations = new Map<string, number>();
  const ends: { conversation_id: string; ended_ts: string }[] = [];
  for (const fact of orderActiveFacts(facts)) {
    if (!fact.kind.startsWith("run.") || !fact.payload) continue;
    const payload = fact.payload as Partial<RunProjection>;
    const generation = payload.generation ?? generations.get(fact.subject);
    if (generation === undefined) continue;
    generations.set(fact.subject, generation);
    const key = JSON.stringify([fact.subject, generation]);
    const previous = runs.get(key);
    const conversation = payload.conversation_id ?? previous?.conversation_id;
    if (!conversation) continue;
    const run: RunProjection = previous ?? { id: conversation + ":" + generation,
      conversation_id: conversation, generation, state: "unknown" };
    // state は保存された申告値。配信時には必ず現在の判定で置き換える。
    for (const field of ["state", "started_ts", "ended_ts", "end_evidence", "cause", "last_evidence", "last_evidence_ts", "reason",
      "base_sha", "pid", "start_fingerprint", "repository_id", "worktree_id", "cwd", "branch", "model", "effort", "launch"] as const) {
      if (field === 'last_evidence' || field === 'last_evidence_ts') {
        const evidence = payload.last_evidence;
        if (evidence && typeof evidence === 'object' && !Array.isArray(evidence) && evidence.native_source) continue;
      }
      if (payload[field] !== undefined) Object.assign(run, { [field]: payload[field] });
    }
    if (payload.state === 'ended' && !payload.ended_ts) run.ended_ts = fact.source_ts;
    if (payload.state === 'ended') ends.push({ conversation_id: conversation, ended_ts: payload.ended_ts ?? fact.source_ts });
    runs.set(key, run);
  }
  return { runs: [...runs.values()].map(normalizeTimestampFields).sort((a, b) => a.id.localeCompare(b.id)), ends };
}
