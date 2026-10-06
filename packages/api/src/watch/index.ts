import { watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { Fact, RunPayload } from "../../../core/src/ledger/facts.ts";
import { prepareProjectionFacts, projectDelegations, projectEntityRecords } from "../../../core/src/ledger/projections/delegations.ts";
import { projectRuns } from "../../../core/src/ledger/projections/runs.ts";
import { ledgerDbPath } from "../paths.ts";

const BATCH_SIZE = 1000;
const POLL_MS = 500;
const EXIT_CODES: Record<string, number> = { done: 0, failed: 1, interrupted: 2, denied: 3 };
export const WATCH_HELP = `Usage: agent-graph-api watch <requestId> | watch --graph <graphId> | watch --conversation <conversationId>
  [--json] [--db <path> | --db-path <path> | --state-dir <path>]
Print the current state, then every state/attempt change in ledger seq order.
Text columns: time, target, state, attempt, reason. --json emits JSON lines (including seq).
Graph watches report each task's latest request and finish when all known tasks are terminal.
Exit codes: 0 done; 1 failed; 2 interrupted; 3 denied; 4 target not found or ledger unreadable.
Mixed graph outcomes use failed, interrupted, denied, done in that priority order.`;

export type WatchTarget = { kind: "request" | "graph" | "conversation"; id: string };
export interface WatchLine {
  time: string;
  target: string;
  state: string;
  attempt: number;
  reason: string;
  seq: number;
}

function readPlannerIdentity(requestId: string): [string, string, number] | undefined {
  if (!requestId.startsWith("planner:")) return;
  let parts: unknown;
  try { parts = JSON.parse(requestId.slice("planner:".length)); }
  catch { return; }
  if (Array.isArray(parts) && parts.length === 3 && typeof parts[0] === "string"
    && typeof parts[1] === "string" && Number.isSafeInteger(parts[2]) && parts[2] > 0) return parts as [string, string, number];
}

function readStates(facts: Fact[], target: WatchTarget): Omit<WatchLine, "time" | "seq">[] {
  const runs = projectRuns(facts);
  if (target.kind === "conversation") {
    const conversations = projectEntityRecords<{ provider: string; native_id: string }>(facts, "conversation");
    const conversation = conversations.find((row) => row.id === target.id
      || JSON.stringify([row.provider, row.native_id]) === target.id);
    if (!conversation) return [];
    const canonicalId = JSON.stringify([conversation.provider, conversation.native_id]);
    const run = runs.filter((row) => row.conversation_id === conversation.id
      || row.conversation_id === canonicalId).sort((a, b) => b.generation - a.generation)[0];
    const evidence = run?.end_evidence as { interrupted?: boolean } | undefined;
    return [{ target: target.id, state: run?.state === "ended" ? (evidence?.interrupted || run.reason === "interrupted" ? "interrupted" : "done")
      : run?.state ?? "unknown", attempt: run?.generation ?? 0, reason: run?.cause ?? run?.reason ?? "" }];
  }
  let delegations = projectDelegations(facts);
  if (target.kind === "request") delegations = delegations.filter((row) => row.request_id === target.id);
  else {
    const tasks = new Map<string, typeof delegations[number]>();
    for (const row of delegations) {
      const identity = readPlannerIdentity(row.request_id);
      if (identity?.[0] !== target.id) continue;
      const previous = tasks.get(identity[1]);
      if (!previous || readPlannerIdentity(previous.request_id)![2] < identity[2]) tasks.set(identity[1], row);
    }
    delegations = [...tasks.values()];
  }
  const runRecords = projectEntityRecords<RunPayload>(facts, "run");
  const active = prepareProjectionFacts(facts);
  return delegations.map((row) => {
    const runId = row.attempts.at(-1)?.run_id;
    const runRecord = runRecords.find((run) => run.id === runId);
    const run = runs.find((run) => run.conversation_id === runRecord?.conversation_id && run.generation === runRecord?.generation);
    const waiting = row.state === "running" && (run?.state === "waiting_approval" || run?.state === "waiting_input");
    const subjects = new Set(facts.filter((fact) => fact.kind === "delegation.created"
      && fact.payload?.request_id === row.request_id).map((fact) => fact.subject));
    const stateFact = active.findLast((fact) => subjects.has(fact.subject) && fact.payload
      && "state" in fact.payload && "attempt" in fact.payload && fact.payload.attempt === row.attempt);
    const payload = stateFact?.payload as { reason?: string } | undefined;
    return { target: row.request_id, state: waiting ? run.state : row.state, attempt: row.attempt, reason: payload?.reason ?? "" };
  });
}

function readExitCode(rows: Omit<WatchLine, "time" | "seq">[]): number | undefined {
  if (!rows.length || rows.some((row) => EXIT_CODES[row.state] === undefined)) return;
  for (const state of ["failed", "interrupted", "denied", "done"]) {
    if (rows.some((row) => row.state === state)) return EXIT_CODES[state];
  }
}

export function formatWatchLine(line: WatchLine, json = false): string {
  if (json) return JSON.stringify(line);
  return [line.time, line.target, line.state, line.attempt, line.reason]
    .map((value) => String(value).replace(/[\r\n\t]/g, " ")).join("\t");
}

export async function watchLedger(options: {
  dbPath: string; target: WatchTarget; write: (line: WatchLine) => void; signal?: AbortSignal;
}): Promise<number> {
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  let timer: ReturnType<typeof setInterval> | undefined;
  let notifier: FSWatcher | undefined;
  let abort: () => void = () => {};
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const read = db.prepare("SELECT * FROM facts WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?");
    const head = db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM facts");
    const facts: Fact[] = [];
    const previous = new Map<string, string>();
    let seq = 0;
    function readBatch(horizon: number): Fact[] {
      return read.all(seq, horizon, BATCH_SIZE).map((row) => ({ ...row,
        payload: row.payload === null ? null : JSON.parse(String(row.payload)),
      } as Fact));
    }
    function retain(fact: Fact): boolean {
      seq = fact.seq;
      if (!/^(delegation|run|conversation)\./.test(fact.kind)) return false;
      facts.push(fact);
      return true;
    }
    function report(time: string): number | undefined {
      const rows = readStates(facts, options.target);
      for (const row of rows) {
        const signature = JSON.stringify([row.state, row.attempt]);
        if (previous.get(row.target) !== signature) {
          options.write({ time, ...row, seq });
          previous.set(row.target, signature);
        }
      }
      return readExitCode(rows);
    }
    // 開始時の上限を固定し、以後の追記は同じ seq の続きで読む。
    const horizon = Number(head.get()!.seq);
    while (seq < horizon) {
      const batch = readBatch(horizon);
      if (!batch.length) break;
      for (const fact of batch) retain(fact);
    }
    if (!readStates(facts, options.target).length) throw new Error("Watch target not found");
    const initial = report(new Date().toISOString());
    if (initial !== undefined) return initial;
    return await new Promise<number>((finish, reject) => {
      let settled = false;
      function complete(code: number) { settled = true; finish(code); }
      function catchUp() {
        if (settled) return;
        try {
          const end = Number(head.get()!.seq);
          while (seq < end) {
            const batch = readBatch(end);
            if (!batch.length) break;
            for (const fact of batch) {
              if (!retain(fact)) continue;
              const code = report(fact.source_ts);
              if (code !== undefined) { complete(code); return; }
            }
          }
        } catch (error) { settled = true; reject(error); }
      }
      abort = () => complete(EXIT_CODES.interrupted);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      // WAL の通知で即時に読み、通知が欠けても定期確認で補う。
      try {
        notifier = watch(dirname(options.dbPath), catchUp);
        notifier.on("error", () => { notifier?.close(); });
      } catch { /* ファイル通知が使えない環境でも seq の確認を続ける。 */ }
      timer = setInterval(catchUp, POLL_MS);
      catchUp();
    });
  } finally {
    clearInterval(timer);
    notifier?.close();
    options.signal?.removeEventListener("abort", abort);
    db.close();
  }
}

export async function runWatchCli(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(WATCH_HELP); return 0; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      graph: { type: "string" }, conversation: { type: "string" }, json: { type: "boolean" },
      db: { type: "string" }, "db-path": { type: "string" }, "state-dir": { type: "string" },
    } });
    if (positionals.length + Number(values.graph !== undefined) + Number(values.conversation !== undefined) !== 1)
      throw new TypeError("Specify one requestId, --graph, or --conversation");
    const target: WatchTarget = values.graph !== undefined ? { kind: "graph", id: values.graph }
      : values.conversation !== undefined ? { kind: "conversation", id: values.conversation }
      : { kind: "request", id: positionals[0] };
    if (!target.id) throw new TypeError("Watch target must not be empty");
    const path = values.db ?? values["db-path"] ?? (values["state-dir"] ? join(values["state-dir"], "agent-graph.db") : ledgerDbPath());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return await watchLedger({ dbPath: resolve(path), target, signal: controller.signal,
      write: (line) => console.log(formatWatchLine(line, values.json)) });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 4;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
