import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectConversations, projectRuns } from "../../../../core/src/ledger/index.ts";
import type { Ledger, RunPayload } from "../../../../core/src/ledger/index.ts";

const MINUTE_MS = 60_000;
interface SessionFile { mtimeMs: number; sessionId: string; pid: number }

/** 一覧を完全に確認できた周期だけ、不在の事実を追記する。 */
export function createClaudeSessionObserver(ledger: Ledger, directory: string) {
  const cached = new Map<string, SessionFile>();
  let lastSignature: string | undefined;
  let lastScanMs = Number.NEGATIVE_INFINITY;
  return function observeClaudeSessions(checkedTs = new Date().toISOString()): number {
    const live = new Set<string>();
    const present = new Set<string>();
    try {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith(".json")) continue;
        const path = join(directory, name);
        present.add(path);
        accessSync(path, constants.R_OK);
        const stat = statSync(path);
        let session = cached.get(path);
        if (!session || session.mtimeMs !== stat.mtimeMs) {
          const row = JSON.parse(readFileSync(path, "utf8"));
          if (!row || typeof row.sessionId !== "string" || !row.sessionId
            || typeof row.cwd !== "string" || !Number.isSafeInteger(row.pid) || row.pid <= 0) return 0;
          session = { mtimeMs: stat.mtimeMs, sessionId: row.sessionId, pid: row.pid };
          cached.set(path, session);
        }
        try { process.kill(session.pid, 0); live.add(session.sessionId); }
        catch (error) {
          // ESRCH だけが不在の根拠。権限や他の失敗では判断しない。
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return 0;
        }
      }
    } catch { return 0; }
    for (const path of cached.keys()) if (!present.has(path)) cached.delete(path);
    // 台帳の全件を読むのは重いので、生きている会話の集合が変わった周期と、1 分ごとの確かめだけにする。
    // 2 つの周期の間に始まって終わった会話も、1 分以内に拾える。
    const signature = JSON.stringify([...live].sort());
    const now = Date.parse(checkedTs);
    if (signature === lastSignature && now - lastScanMs < MINUTE_MS) return 0;
    lastSignature = signature;
    lastScanMs = now;

    const facts = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
    const conversations = projectConversations(facts, new Map()).conversations;
    const eligible = new Map(conversations.filter(row => row.provider === "claude"
      && row.origin === "observed" && row.type !== "subagent").flatMap(row =>
      [[row.id, row], [`claude:${row.native_id}`, row]] as const));
    const subjects = new Map<string, `run:${string}`>();
    for (const fact of facts) {
      if (fact.kind !== "run.created" || !fact.payload) continue;
      const payload = fact.payload as Partial<RunPayload>;
      subjects.set(JSON.stringify([payload.conversation_id, payload.generation]), fact.subject as `run:${string}`);
    }
    const latest = new Map<string, ReturnType<typeof projectRuns>[number]>();
    for (const run of projectRuns(facts)) {
      const conversation = eligible.get(run.conversation_id);
      if (conversation && run.generation > (latest.get(conversation.id)?.generation ?? -1)) latest.set(conversation.id, run);
    }
    const known = new Set(facts.filter(fact => fact.source === "transcript-claude").map(fact => fact.source_event_id));
    const minute = Math.floor(Date.parse(checkedTs) / MINUTE_MS);
    let appended = 0;
    for (const [id, run] of latest) {
      const conversation = eligible.get(id)!;
      if (live.has(conversation.native_id!) || !["running", "waiting_approval", "waiting_input"].includes(run.state)) continue;
      const eventId = `process_absent:${id}:${minute}`;
      const subject = subjects.get(JSON.stringify([run.conversation_id, run.generation]));
      if (!subject || known.has(eventId)) continue;
      const result = ledger.append({ source: "transcript-claude", source_event_id: eventId,
        kind: "run.state_changed", subject, confidence: "confirmed", source_ts: checkedTs, observed_ts: checkedTs,
        payload: { conversation_id: run.conversation_id, generation: run.generation, state: "idle",
          last_evidence: { kind: "process_absent", checked_ts: checkedTs }, last_evidence_ts: checkedTs } });
      if (result.status === "conflict") throw new Error(`Conflicting Claude process observation: ${id}`);
      if (result.status === "appended") appended += 1;
    }
    return appended;
  };
}
