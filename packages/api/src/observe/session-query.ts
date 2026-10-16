import type { DatabaseSync } from "node:sqlite";
import { projectConversations, projectRuns, readLedgerDatabase } from "../../../core/src/ledger/index.ts";
import type { Fact, Ledger, RunPayload } from "../../../core/src/ledger/index.ts";
import { basename } from "node:path";

const ROLLOUT_NAME = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
export interface SessionRun {
  id: string;
  nativeId: string;
  subject: `run:${string}`;
  conversation_id: string;
  generation: number;
  last_evidence_ts?: string;
  lastRecord: number;
}

/** 投影が追いついていない取り込み周期だけ、会話と実行の事実を SQL で絞って投影する。 */
export function createSessionQuery(ledger: Ledger, db: DatabaseSync = readLedgerDatabase(ledger), initialize = true) {
  // 取引を持つ生存観測の前に、書き手の接続だけでファイル時刻の索引を用意する。
  if (initialize) db.exec(`CREATE INDEX IF NOT EXISTS api_session_file_records
    ON facts (json_extract(cursor, '$.file_id'), source_ts)
    WHERE source = 'rollout-codex' AND cursor IS NOT NULL`);
  const revision = db.prepare("SELECT last_seq = (SELECT coalesce(max(seq), 0) FROM facts) AS current FROM projection_state WHERE id = 1");
  const active = db.prepare(`SELECT c.id, c.native_id, r.conversation_id, r.generation, r.last_evidence_ts,
      'run:' || s.subject_id AS subject
    FROM runs r JOIN conversations c ON r.conversation_id IN (c.id, c.provider || ':' || c.native_id)
    JOIN run_subjects s ON s.conversation_id = r.conversation_id AND s.generation = r.generation
    WHERE c.provider = ? AND c.origin = 'observed' AND (? <> 'claude' OR coalesce(c.type, '') <> 'subagent')
      AND r.state IN ('running', 'waiting_approval', 'waiting_input')
      AND NOT EXISTS (SELECT 1 FROM runs newer
        WHERE newer.conversation_id IN (c.id, c.provider || ':' || c.native_id) AND newer.generation > r.generation)`);
  const metadata = db.prepare(`SELECT * FROM facts WHERE seq IN (
    SELECT seq FROM fact_projection_dependencies WHERE projection = 'conversations' AND direction = 'offers'
      AND key GLOB 'conversation:*') AND kind GLOB 'conversation.*' ORDER BY seq`);
  const runSubjects = db.prepare(`SELECT DISTINCT subject, json_extract(payload, '$.conversation_id') AS conversation_id FROM facts
    WHERE seq IN (SELECT seq FROM fact_projection_dependencies
      WHERE projection = 'runs' AND direction = 'needs'
        AND key IN (SELECT 'run-conversation:' || value FROM json_each(?))) AND kind = 'run.created'`);
  const runFacts = db.prepare("SELECT * FROM facts WHERE subject IN (SELECT value FROM json_each(?)) AND kind GLOB 'run.*' ORDER BY seq");
  const exists = db.prepare("SELECT 1 FROM facts WHERE source = ? AND source_event_id = ?");
  const cursors = db.prepare(`SELECT subject, cursor FROM facts INDEXED BY facts_subject_seq
    WHERE kind IN ('conversation.created', 'conversation.corrected') AND source = 'rollout-codex'
      AND subject IN (SELECT value FROM json_each(?)) AND cursor IS NOT NULL`);
  const records = db.prepare(`SELECT subject AS key, max(round(unixepoch(source_ts, 'subsec') * 1000)) AS ts
    FROM facts WHERE subject IN (SELECT value FROM json_each(?)) GROUP BY subject`);
  let fileRecords: ReturnType<DatabaseSync["prepare"]> | undefined;
  function readFileRecords(files: string[]) {
    // ファイルとの対応がない周期には、ファイル側の問い合わせを実行しない。
    if (!fileRecords) {
      fileRecords = db.prepare(`SELECT json_extract(cursor, '$.file_id') AS key,
        max(round(unixepoch(source_ts, 'subsec') * 1000)) AS ts FROM facts INDEXED BY api_session_file_records
        WHERE source = 'rollout-codex' AND cursor IS NOT NULL
          AND json_extract(cursor, '$.file_id') IN (SELECT value FROM json_each(?)) GROUP BY key`);
    }
    return fileRecords.iterate(JSON.stringify(files));
  }
  return {
    hasEvent(source: string, eventId: string): boolean { return !!exists.get(source, eventId); },
    read(provider: "claude" | "codex"): SessionRun[] {
      let rows: SessionRun[];
      if (revision.get()!.current) {
        rows = active.all(provider, provider).map(row => ({ id: String(row.id), nativeId: String(row.native_id),
          subject: row.subject as `run:${string}`, conversation_id: String(row.conversation_id),
          generation: Number(row.generation), last_evidence_ts: row.last_evidence_ts as string | undefined, lastRecord: 0 }));
      } else {
        const facts = metadata.all().map(row => ({ ...row,
          payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
        const eligible = new Map(projectConversations(facts, new Map()).conversations
          .filter(row => row.provider === provider && row.origin === "observed" && (provider !== "claude" || row.type !== "subagent"))
          .flatMap(row => [[row.id, row], [`${provider}:${row.native_id}`, row]] as const));
        const selected = runSubjects.all(JSON.stringify([...eligible.keys()])).map(row => String(row.subject));
        const runs = runFacts.all(JSON.stringify(selected)).map(row => ({ ...row,
          payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
        const subjects = new Map<string, `run:${string}`>();
        for (const fact of runs) if (fact.kind === "run.created" && fact.payload) {
          const payload = fact.payload as Partial<RunPayload>;
          subjects.set(JSON.stringify([payload.conversation_id, payload.generation]), fact.subject as `run:${string}`);
        }
        const latest = new Map<string, ReturnType<typeof projectRuns>[number]>();
        for (const run of projectRuns(runs)) {
          const conversation = eligible.get(run.conversation_id);
          if (conversation && run.generation > (latest.get(conversation.id)?.generation ?? -1)) latest.set(conversation.id, run);
        }
        rows = [];
        for (const [id, run] of latest) {
          const subject = subjects.get(JSON.stringify([run.conversation_id, run.generation]));
          if (subject && ["running", "waiting_approval", "waiting_input"].includes(run.state)) rows.push({ id,
            nativeId: eligible.get(id)!.native_id!, subject, conversation_id: run.conversation_id,
            generation: run.generation, last_evidence_ts: run.last_evidence_ts, lastRecord: 0 });
        }
      }
      if (provider !== "codex" || !rows.length) return rows;
      const targets = new Map<string, SessionRun[]>();
      function addTarget(key: string, row: SessionRun): void {
        const matches = targets.get(key) ?? [];
        matches.push(row);
        targets.set(key, matches);
      }
      const conversations = new Map(rows.map(row => [`conversation:${row.id}`, row]));
      for (const row of rows) { addTarget(row.subject, row); addTarget(`conversation:${row.id}`, row); }
      // 古い世代の遅れて届いた記録も、同じ会話の直近の記録として保つ。
      const byConversation = new Map(rows.flatMap(row => [[row.id, row], [`codex:${row.nativeId}`, row]] as const));
      for (const record of runSubjects.iterate(JSON.stringify([...byConversation.keys()]))) {
        const row = byConversation.get(String(record.conversation_id));
        if (row) addTarget(String(record.subject), row);
      }
      const files: string[] = [];
      for (const fact of cursors.iterate(JSON.stringify([...conversations.keys()]))) {
        const row = conversations.get(String(fact.subject))!;
        const fileId = (JSON.parse(String(fact.cursor)) as { file_id?: string }).file_id;
        if (fileId && ROLLOUT_NAME.exec(basename(fileId))?.[1] === row.nativeId) {
          files.push(fileId);
          addTarget(fileId, row);
        }
      }
      for (const record of records.iterate(JSON.stringify([...targets.keys()]))) {
        for (const row of targets.get(String(record.key)) ?? []) row.lastRecord = Math.max(row.lastRecord, Number(record.ts));
      }
      if (files.length) for (const record of readFileRecords(files)) {
        for (const row of targets.get(String(record.key)) ?? []) row.lastRecord = Math.max(row.lastRecord, Number(record.ts));
      }
      return rows;
    },
  };
}
