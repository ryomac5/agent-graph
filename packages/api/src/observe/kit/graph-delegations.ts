import { normalizeTimestamp, projectDelegations, type AppendResult, type DelegationState, type Ledger, type Fact, type FactInput, type JsonValue } from "../../../../core/src/ledger/index.ts";
import { readAppendOnlyFile } from "../files.ts";

type Row = Record<string, JsonValue>;
const TERMINAL_STATES: Record<string, DelegationState> = {
  done: "done", failed: "failed", cancelled: "interrupted", lost: "failed", rejected: "denied",
};

function identifyStart(session: unknown, nodeId: unknown, ts: string): string {
  return JSON.stringify([session, nodeId, normalizeTimestamp(ts)]);
}

/** 旧 cursor より前の終了も、未終了の graph 委譲にだけ追記して補う。 */
export function reconcileGraphDelegations(ledger: Ledger, path: string, facts: Fact[]): AppendResult[] {
  const delegations = facts.filter((fact) => fact.kind.startsWith("delegation."));
  const open = new Set(projectDelegations(delegations).filter((entry) =>
    ["running", "verifying", "reviewing"].includes(entry.state)).map((entry) => entry.request_id));
  const starts = new Map<string, string>();
  for (const fact of delegations) {
    if (fact.source !== "kit" || fact.kind !== "delegation.created" || !fact.payload) continue;
    const kit = (fact.payload as unknown as Row).kit as Row | undefined;
    if (kit?.file !== path || kit.origin !== "graph" || !open.has(fact.payload.request_id!)) continue;
    starts.set(identifyStart(kit.session, kit.node_id, fact.source_ts), fact.payload.request_id!);
  }
  if (!starts.size) return [];
  const active = new Map<string, { session: string; task: string; generation: number }>();
  const runs = new Map<string, { generation: number; row: Row }>();
  const results: AppendResult[] = [];
  function close(requestId: string, row: Row, state: DelegationState, status: string): void {
    const result = ledger.append({ source: "kit", source_event_id: `kit:graph-terminal:${requestId}`,
      source_ts: String(row.ts), confidence: "confirmed", kind: "delegation.state_changed",
      subject: `delegation:${requestId}`, payload: { attempt: 1, state,
        result: { status, reason: row.reason ?? null },
        kit: { file: path, session: String(row.session), event: String(row.event), task_id: row.task_id ?? row.task ?? null } } } as FactInput);
    if (result.status === "conflict") throw new Error(`Conflicting graph terminal: ${requestId}`);
    results.push(result);
    active.delete(requestId);
  }
  // 行順で開始を有効にし、後の試行を古い終了に結び付けない。
  for (const line of readAppendOnlyFile(path).lines) {
    let value: unknown;
    try { value = JSON.parse(line.text); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Row;
    if (typeof row.session !== "string" || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) continue;
    const session = row.session;
    if (row.event === "graph_run") {
      runs.set(session, { generation: (runs.get(session)?.generation ?? 0) + 1, row });
      continue;
    }
    const task = row.event === "codex_start" && row.origin === "graph" && typeof row.node_id === "string"
      ? /^(.*)-a[1-9]\d*$/.exec(row.node_id)?.[1]
      : row.event === "task_state" ? row.task_id ?? row.task : undefined;
    const run = runs.get(session);
    for (const [requestId, entry] of active) {
      if (entry.session !== session) continue;
      if (row.event === "graph_closed") close(requestId, row, "interrupted", "cancelled");
      else if (typeof task === "string" && entry.task === task) {
        // graph_run は件数だけを持つため、再登場した task に限って前回分を閉じる。
        if (run && entry.generation < run.generation) close(requestId, run.row, "interrupted", "cancelled");
        else if (row.event === "task_state" && typeof row.state === "string" && Object.hasOwn(TERMINAL_STATES, row.state)) {
          close(requestId, row, TERMINAL_STATES[row.state], row.state);
        }
      }
    }
    if (row.event === "codex_start" && row.origin === "graph" && typeof task === "string") {
      const identity = identifyStart(session, row.node_id, row.ts);
      const requestId = starts.get(identity);
      if (requestId) {
        active.set(requestId, { session, task, generation: run?.generation ?? 0 });
        starts.delete(identity);
      }
    }
  }
  return results;
}
