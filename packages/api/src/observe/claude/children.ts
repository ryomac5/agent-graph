import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { evaluateState, readNativeEvidence, readNativeTurnId } from "../../../../core/src/state/index.ts";
import type { ProcessIdentity, StateEvidence } from "../../../../core/src/state/index.ts";
import { getMessageText } from "../../../../core/src/ledger/projections/messages.ts";
import type { JsonValue, Ledger } from "../../../../core/src/ledger/index.ts";
import { createSessionQuery } from "../session-query.ts";
import { readAppendOnlyFile, type FileCursor } from "../files.ts";
import { readRemoteMetadata } from "../../remote/observation.ts";

const SCAN_VALID_MS = 30_000;
function normalizeStart(value: string): string {
  const epoch = Date.parse(/^[A-Za-z]{3} [A-Za-z]{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4}$/.test(value) ? `${value} GMT` : value);
  return Number.isFinite(epoch) ? String(epoch) : value;
}
export function readClaudeProcessStarts(): Map<number, string> {
  const output = execFileSync("ps", ["-axo", "pid=,lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Map(output.trim().split("\n").filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error("Incomplete process listing");
    return [Number(match[1]), normalizeStart(match[2])];
  }));
}
type Registration = ProcessIdentity & { startedAt: number };
type Snapshot = { at: number; sessions: Map<string, Registration>; processes: Map<number, string> };
type History = { cursor?: FileCursor; rows: { turn: string | null; signals: StateEvidence[]; notification?: string; at: number; id: string }[] };

/** 起動前の走査だけを親の組に使い、既存の子には現在の親を補完しない。 */
export function createClaudeChildObserver(ledger: Ledger, directory: string,
  query = createSessionQuery(ledger), readProcesses = readClaudeProcessStarts) {
  let snapshot: Snapshot | undefined;
  const histories = new Map<string, History>();
  function readHistory(path: string, notificationsOnly = false): History["rows"] {
    const previous = histories.get(path);
    const read = readAppendOnlyFile(path, previous?.cursor);
    const rows = read.reset ? [] : previous?.rows ?? [];
    for (const line of read.lines) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line.text); } catch { continue; }
      if (!row || typeof row !== "object") continue;
      const at = Date.parse(String(row.timestamp));
      if (!Number.isFinite(at)) continue;
      // 本文全体を保持せず、状態証拠または子への通知だけを残す。
      const id = `${line.cursor.identity}:${line.cursor.offset}:${line.cursor.hash}`;
      const signals = notificationsOnly ? [] : readNativeEvidence({ source: "claude", runId: "probe", id, at, observedAt: at, row });
      const text = row.type === "queue-operation" && row.operation === "enqueue" ? row.content
        : row.type === "user" ? (row.message as { content?: unknown })?.content : undefined;
      const notification = getMessageText(text as JsonValue ?? null).trim();
      if (signals.length || notification.startsWith("<task-notification>")) {
        rows.push({ turn: readNativeTurnId("claude", row), signals, at, id,
          ...(notification.startsWith("<task-notification>") ? { notification } : {}) });
      }
    }
    histories.set(path, { cursor: read.cursor, rows });
    return rows;
  }
  return {
    parentAtLaunch(parent: string, started: number): ProcessIdentity | null {
      const session = snapshot?.sessions.get(parent);
      if (!snapshot || !session || snapshot.at > started || started >= snapshot.at + SCAN_VALID_MS
        || session.startedAt > started || snapshot.processes.get(session.pid) !== session.procStart) return null;
      return { pid: session.pid, procStart: session.procStart };
    },
    observe(paths: string[], checkedTs?: string): number {
      let scanned: Omit<Snapshot, "at"> | undefined;
      try {
        if (!existsSync(directory)) throw new Error("Session directory unavailable");
        const names = readdirSync(directory).filter(name => name.endsWith(".json"));
        const processes = readProcesses();
        const sessions = new Map<string, Registration>();
        for (const name of names) {
          const row = JSON.parse(readFileSync(join(directory, name), "utf8"));
          if (!row || typeof row.sessionId !== "string" || !Number.isSafeInteger(row.pid) || row.pid <= 0
            || !Number.isFinite(row.startedAt)) throw new Error("Incomplete session registration");
          const procStart = typeof row.procStart === "string" ? normalizeStart(row.procStart) : processes.get(row.pid);
          if (sessions.has(row.sessionId)) throw new Error("Ambiguous session registration");
          if (procStart) sessions.set(row.sessionId, { pid: row.pid, procStart, startedAt: row.startedAt });
        }
        scanned = { sessions, processes };
      } catch { /* 失敗では以前の確認の期限を延ばさない。 */ }
      checkedTs ??= new Date().toISOString();
      const now = Date.parse(checkedTs);
      if (scanned) snapshot = { ...scanned, at: now };
      const children = new Map(paths.filter(path => basename(dirname(path)) === "subagents")
        .map(path => [basename(path, ".jsonl"), path]));
      if (!children.size) { histories.clear(); return 0; }
      let appended = 0;
      const used = new Set<string>();
      for (const run of query.read("claude", true)) {
        const path = children.get(run.nativeId);
        if (!path || readRemoteMetadata(path)) continue;
        const parentId = basename(dirname(dirname(path)));
        const parentPath = join(dirname(dirname(dirname(path))), `${parentId}.jsonl`);
        used.add(path); used.add(parentPath);
        let rows: History["rows"], parentRows: History["rows"];
        try { rows = readHistory(path); } catch { continue; }
        try { parentRows = readHistory(parentPath, true); } catch { parentRows = []; }
        const turn = rows.filter(entry => entry.at <= now).findLast(entry => entry.turn)?.turn ?? null;
        const evidence: StateEvidence[] = rows.flatMap(entry => entry.signals.map(signal => ({ ...signal, runId: run.id })));
        // 子自身の turn が一意に分かる通知だけを対応付ける。親の promptId は使わない。
        const turnStarts = new Map<string, number>();
        for (const entry of rows) {
          const id = entry.turn;
          if (id) turnStarts.set(id, Math.min(turnStarts.get(id) ?? Infinity, entry.at));
        }
        for (const entry of parentRows) {
          const targets = [...turnStarts].filter(([, at]) => at <= entry.at).sort((a, b) => b[1] - a[1]);
          if (!targets.length || targets[1]?.[1] === targets[0][1]) continue;
          evidence.push(...readNativeEvidence({ ...entry, source: "claude_child", runId: run.id,
            row: { type: "queue-operation", operation: "enqueue", content: entry.notification },
            observedAt: entry.at, childId: run.nativeId.replace(/^agent-/, ""), turnId: targets[0][0] }));
        }
        const owner = run.launch?.parentProcessAtLaunch as ProcessIdentity | null | undefined;
        const current = snapshot?.sessions.get(parentId);
        if (snapshot) evidence.push({ id: `parent-scan:${snapshot.at}`, kind: "scan", source: "claude_session",
          scope: run.id, subjects: [run.id], at: snapshot.at, observedAt: snapshot.at, validForMs: SCAN_VALID_MS,
          status: "succeeded", processes: [...snapshot.processes].map(([pid, procStart]) => ({ pid, procStart })) });
        const state = evaluateState({ runId: run.id, turnId: turn, process: current ?? owner ?? null,
          parentProcessAtLaunch: owner ?? null, attempt: null, evidence }, now);
        const interrupted = evidence.some(entry => entry.kind === "signal" && entry.event === "interrupted"
          && entry.turnId === turn && entry.at <= now);
        if (state.display.label === "Working" || state.display.label === "Waiting" || state.display.label === "Needs approval") continue;
        // この移植では、親の確認不足と停止通知による作業中の解除だけを行う。
        if (!interrupted && state.process.value === "alive_confirmed") continue;
        const reason = interrupted ? "boundary_unavailable" : state.process.reason;
        const eventId = `child-unverified:${run.id}:${run.generation}:${run.last_evidence_ts}:${reason}`;
        if (query.hasEvent("transcript-claude", eventId)) continue;
        const result = ledger.append({ source: "transcript-claude", source_event_id: eventId,
          source_ts: checkedTs, observed_ts: checkedTs, confidence: "confirmed", kind: "run.state_changed", subject: run.subject,
          payload: { conversation_id: run.conversation_id, generation: run.generation, state: "unknown", reason,
            last_evidence: { kind: "child_unverified", reason }, last_evidence_ts: checkedTs } });
        if (result.status === "conflict") throw new Error(`Conflicting child observation: ${run.id}`);
        if (result.status === "appended") appended++;
      }
      for (const path of histories.keys()) if (!used.has(path)) histories.delete(path);
      return appended;
    },
  };
}
