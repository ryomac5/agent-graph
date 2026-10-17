import { VISIBLE_CONVERSATION_SQL } from '../usage/probe-path.ts';
import { projectRoots, connectRootDelegations, type RootProjection, type RootConversation } from "../../../core/src/ledger/projections/roots.ts";
import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { Fact } from "../../../core/src/ledger/facts.ts";
import { PROJECTION_TABLES, type ProjectionState } from "../../../core/src/ledger/rebuild.ts";
import { projectProjects } from "../../../core/src/ledger/projections/projects.ts";
import { getMessageText } from "../../../core/src/ledger/projections/messages.ts";
import { compareEventOrder, encodeEventOrder } from "../../../core/src/ledger/event-order.ts";
import { resolveProjectLocation } from "../../../core/src/ledger/repository.ts";
import { compactScreenIdentities, createScreenIdentities, type ScreenIdentities } from './screen-identities.ts';
import type { ObservationProgress } from "./index.ts";

import { initializeSummaryIndex, LATEST_MESSAGE_SQL, FALLBACK_MESSAGE_SQL } from "./summary-index.ts";
import { normalizeTimestampFields } from "../../../core/src/ledger/timestamps.ts";

export type ProjectionRows = Record<string, Record<string, unknown>[]>;
export interface ProjectionPatch {
  type: "patch"; from_seq: number; seq: number; generation: number;
  changes: Record<string, { upsert: Record<string, unknown>[]; remove: string[] }>;
  identities?: ScreenIdentities;
  // 本文は履歴へ複製せず、購読する会話だけ SQLite から取得する。
  detail?: { messages: string[]; memberships: string[]; conversations: string[];
    membership_conversations: Record<string, string[]> };
}
const PATCH_RETENTION = 1000;
const LOCK_LOG_INTERVAL_MS = 60_000;
const PATCH_RETENTION_BYTES = 16 * 1024 * 1024;
const LIST_PAGE_SIZE = 1000;
const EXCERPT_LENGTH = 120;
const DETAIL_PAGE_SIZE = 200;
export interface MessageCursor { source_ts: string; source_event_id: string; id: string }
function compareMessageCursors(a: MessageCursor, b: MessageCursor): number {
  return a.source_ts.localeCompare(b.source_ts)
    || compareEventOrder(a.source_event_id, b.source_event_id) || compareEventOrder(a.id, b.id);
}
function readMessageCursor(value: string | MessageCursor): string | MessageCursor {
  if (typeof value !== 'string') return normalizeTimestampFields(value);
  // HTTP の before には組を JSON で載せる。旧い ID（JSON 配列を含む）も受ける。
  try {
    const cursor = JSON.parse(value);
    if (cursor && typeof cursor.source_ts === 'string' && typeof cursor.source_event_id === 'string'
      && typeof cursor.id === 'string') return normalizeTimestampFields(cursor);
  } catch { /* 旧い ID はそのまま使う。 */ }
  return value;
}
const NAME_LENGTH = 160;
const SCREEN_CACHE_KIB = 16 * 1024;
const IDENTITY_BATCH_FACTS = 256;
const LIST_TABLES = PROJECTION_TABLES.filter(table => table !== "messages" && table !== "message_memberships");
const LIST_COLUMNS: Record<string, string> = {
  tasks: "id, name, project, state",
  runs: "id, conversation_id, generation, state, started_ts, turn_started_ts, ended_ts, end_evidence, cause, last_evidence, last_evidence_ts, reason, repository_id, worktree_id, cwd, branch, launch, model, effort",
  artifacts: "id, run_id, version, repository_id, worktree_id, patch_hash, attribution, previous_artifact_id",
  // 承認は、何を許すかの要求の中身と、選べる判断がないと答えられない。
  approvals: "id, run_id, connection_id, conversation_id, request_id, state, available_decisions, decision, request, reason, artifact_id, patch_hash, requested_ts",
  findings: "id, artifact_id, version, file, start_line, end_line, severity, state",
};
function decodeFacts(rows: Record<string, unknown>[]): Fact[] {
  return rows.map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
}
function readRelationParts(id: unknown): string[] | undefined {
  let parts: unknown;
  try { parts = JSON.parse(String(id)); } catch { return; }
  if (Array.isArray(parts) && parts.length === 4 && parts.every(value => typeof value === 'string')) return parts;
}
function compactRelation(row: Record<string, unknown>): Record<string, unknown> {
  const parts = readRelationParts(row.id);
  if (!parts) return row;
  // 関係 ID に既に含まれる値だけ省く。独自 ID と訂正で異なる値はそのまま残す。
  const result = { ...row };
  for (const [index, key] of ['type', 'from_id', 'to_id', 'evidence'].entries()) {
    if (row[key] === parts[index]) delete result[key];
  }
  return result;
}

export class ProjectionFeed {
  private db: DatabaseSync;
  private catchUp: () => ProjectionState;
  private state: ProjectionState;
  private history: ProjectionPatch[] = [];
  private historyBytes = 0;
  private serialized = new WeakMap<ProjectionPatch, string>();
  private historySizes: number[] = [];
  private floor: number;
  private limit: number;
  private cursor = 0;
  private roots: RootProjection[] = [];
  private requiresGeneration: boolean;
  private identities: ScreenIdentities = { conversations: {}, runs: {} };
  private observation?: ObservationProgress;
  private projectBaseline?: { projects: Map<string, Record<string, SQLOutputValue>>; references: Map<string, string> };
  private registeredRepositories = new Map<string, string[]>();
  private statements = new Map<string, StatementSync>();
  private inputQueues = new Map<string, unknown[]>();
  private lastLockLogAt?: number;
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  constructor(path: string, catchUp: () => ProjectionState, limit = PATCH_RETENTION) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid patch retention");
    this.state = catchUp();
    this.observation = (this.state as ProjectionState & { observation?: ObservationProgress }).observation;
    this.requiresGeneration = this.state.generation > 0;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA cache_size = -${SCREEN_CACHE_KIB}`);
    this.catchUp = catchUp;
    this.limit = limit;
    // 前の実装が残した全レコード用の trigger は、起動時に外す。
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      this.db.exec(`DROP TRIGGER IF EXISTS api_change_conversation_record_${operation}`);
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_projection_changes (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, id TEXT NOT NULL, conversation_id TEXT);
      CREATE TABLE IF NOT EXISTS api_conversation_summaries (id TEXT PRIMARY KEY, message_count INTEGER NOT NULL,
        last_message_ts TEXT, last_message_excerpt TEXT);
      CREATE TABLE IF NOT EXISTS api_projects (id TEXT PRIMARY KEY, display_name TEXT, root_path TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS api_conversation_ids (id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS api_conversation_canonical ON api_conversation_ids(canonical_id);
      CREATE TABLE IF NOT EXISTS api_project_resolution (id TEXT PRIMARY KEY, project_id TEXT, state TEXT)`);
    // 投影の取引と一緒に変更を記録する。再構築と削除も同じ経路で検出する。
    for (const table of PROJECTION_TABLES) for (const [operation, prefix] of [["INSERT", "NEW"], ["UPDATE", "NEW"], ["DELETE", "OLD"]]) {
      const conversation = table === "message_memberships" ? `${prefix}.conversation_id` : "NULL";
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS api_change_${table}_${operation} AFTER ${operation} ON ${table}
        BEGIN INSERT INTO api_projection_changes(table_name, id, conversation_id) VALUES ('${table}', ${prefix}.id, ${conversation});
        ${table === "message_memberships" && operation === "UPDATE" ? `INSERT INTO api_projection_changes(table_name, id, conversation_id) VALUES ('${table}', OLD.id, OLD.conversation_id);` : ""}
        END`);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.prepare("SELECT last_seq, generation FROM projection_state WHERE id = 1").get()!;
      this.state = { ...this.state, last_seq: Number(stored.last_seq), generation: Number(stored.generation) };
      this.requiresGeneration = this.state.generation > 0;
      this.db.exec("CREATE INDEX IF NOT EXISTS api_identity_subject_seq ON facts(subject, seq) WHERE kind GLOB 'conversation.*' OR kind = 'run.created'");
      this.db.exec(`CREATE INDEX IF NOT EXISTS api_root_name_subject_seq ON facts(subject, seq)
        WHERE kind GLOB 'conversation.*' AND json_type(payload, '$.user_name') IS NOT NULL`);
      initializeSummaryIndex(this.db);
      this.updateIdentities();
      this.updateProjects();
      this.projectBaseline = undefined;
      this.db.exec("DELETE FROM api_conversation_summaries");
      for (const row of this.prepare("SELECT id FROM conversations").iterate()) this.updateSummary(String(row.id));
      this.cursor = Number(this.prepare("SELECT coalesce(max(cursor), 0) AS cursor FROM api_projection_changes").get()!.cursor);
      this.prepare("DELETE FROM api_projection_changes WHERE cursor <= ?").run(this.cursor);
      this.updateInputQueues();
      this.roots = this.readRoots();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    this.floor = this.state.last_seq;
    this.db.exec("PRAGMA busy_timeout = 0");
  }
  private updateInputQueues(ids?: string[]): void {
    if (ids?.length === 0) return;
    if (ids === undefined) this.inputQueues.clear();
    else for (const id of ids) this.inputQueues.delete(id);
    const where = ids === undefined ? "" : "AND entity_id IN (SELECT value FROM json_each(?))";
    const statement = this.prepare(`SELECT entity_id, json_extract(data, '$.pending_inputs') AS inputs
      FROM projection_records WHERE projection = 'conversations' ${where}`);
    const rows = ids === undefined ? statement.iterate() : statement.iterate(JSON.stringify(ids));
    for (const row of rows) {
      const inputs = row.inputs ? JSON.parse(String(row.inputs)) : [];
      if (inputs.length) this.inputQueues.set(String(row.entity_id), inputs);
    }
  }
  private updateIdentities(sinceSeq?: number): ScreenIdentities {
    const subset = sinceSeq === undefined ? "" : `AND subject IN (SELECT subject FROM facts WHERE seq > ? AND seq <= ?
      AND (kind GLOB 'conversation.*' OR kind = 'run.created') AND kind != 'conversation.input_queue_changed')`;
    const rows = this.prepare(`SELECT seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes,
        json_patch('{}', json_object('provider', json_extract(payload, '$.provider'), 'native_id', json_extract(payload, '$.native_id'),
          'conversation_id', json_extract(payload, '$.conversation_id'), 'generation', json_extract(payload, '$.generation'))) AS payload
      FROM facts WHERE seq <= ? AND (kind GLOB 'conversation.*' OR kind = 'run.created') AND kind != 'conversation.input_queue_changed' ${subset} ORDER BY subject, seq`)
      .iterate(...(sinceSeq === undefined ? [this.state.last_seq] : [this.state.last_seq, sinceSeq, this.state.last_seq]));
    const next: ScreenIdentities = { conversations: {}, runs: {} };
    const createdRuns: { conversation_id: string; generation: number; subject_id: string }[] = [];
    let batch: Record<string, unknown>[] = [];
    function flush(): void {
      const decoded = decodeFacts(batch);
      Object.assign(next.conversations, createScreenIdentities(decoded).conversations);
      for (const fact of decoded) {
        if (fact.kind === "run.created" && fact.payload?.conversation_id && fact.payload.generation !== undefined) {
          createdRuns.push({ conversation_id: fact.payload.conversation_id, generation: fact.payload.generation,
            subject_id: fact.subject.slice(4) });
        }
      }
      batch = [];
    }
    // 同じ subject の訂正はまとめ、会話全体の中間オブジェクトを保持しない。
    for (const row of rows) {
      if (batch.length >= IDENTITY_BATCH_FACTS && batch.at(-1)!.subject !== row.subject) flush();
      batch.push(row);
    }
    flush();
    const changed: ScreenIdentities = { conversations: {}, runs: {} };
    if (sinceSeq === undefined) { this.identities = { conversations: {}, runs: {} }; this.db.exec("DELETE FROM api_conversation_ids"); }
    const insert = this.prepare("INSERT OR REPLACE INTO api_conversation_ids VALUES (?, ?)");
    for (const [id, canonical] of Object.entries(next.conversations)) {
      if ((this.identities.conversations[id] ?? id) !== canonical) changed.conversations[id] = canonical;
      if (id === canonical) { delete this.identities.conversations[id]; this.prepare("DELETE FROM api_conversation_ids WHERE id = ?").run(id); }
      else { this.identities.conversations[id] = canonical; insert.run(id, canonical); }
    }
    const runs = this.prepare(`SELECT conversation_id, generation, subject_id FROM run_subjects
      WHERE conversation_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(Object.keys(next.conversations)));
    for (const row of createdRuns) runs.push(row);
    for (const row of runs) {
      const id = String(row.conversation_id);
      const canonical = `${this.identities.conversations[id] ?? id}:${row.generation}`;
      for (const original of [String(row.subject_id), `${id}:${row.generation}`]) {
        if ((this.identities.runs[original] ?? original) !== canonical) changed.runs[original] = canonical;
        if (original === canonical) delete this.identities.runs[original];
        else this.identities.runs[original] = canonical;
      }
    }
    return changed;
  }
  private updateProjects(): { upsert: Record<string, unknown>[]; remove: string[]; resolved: string[] } {
    const projects = projectProjects(decodeFacts(this.prepare("SELECT * FROM facts WHERE seq <= ? AND kind LIKE 'project.%' ORDER BY seq").all(this.state.last_seq)));
    // 部分書き込みの後も、配信済みの状態を比較の基準に残す。
    this.projectBaseline ??= {
      projects: new Map(this.prepare("SELECT * FROM api_projects").all().map(row => [String(row.id), row])),
      references: new Map(this.prepare("SELECT * FROM api_project_resolution").all()
        .map(row => [String(row.id), JSON.stringify(row)])),
    };
    const previous = new Map(this.projectBaseline.projects);
    const insert = this.prepare("INSERT OR REPLACE INTO api_projects VALUES (?, ?, ?, ?)");
    const upsert: Record<string, unknown>[] = [];
    for (const project of projects) {
      const row = { id: project.id, display_name: project.display_name ?? null, root_path: project.root_path ?? null, state: project.state ?? "unregistered" };
      if (JSON.stringify(previous.get(row.id)) !== JSON.stringify(row)) {
        insert.run(row.id, row.display_name, row.root_path, row.state); upsert.push(row);
      }
      previous.delete(row.id);
    }
    for (const id of previous.keys()) this.prepare("DELETE FROM api_projects WHERE id = ?").run(id);
    const previousReferences = this.projectBaseline.references;
    this.db.exec("DELETE FROM api_project_resolution");
    this.registeredRepositories.clear();
    for (const row of this.prepare("SELECT id, root_path FROM api_projects WHERE state = 'registered' AND root_path IS NOT NULL").iterate()) {
      const location = resolveProjectLocation(String(row.root_path));
      if (location.reason === "missing") continue;
      const ids = this.registeredRepositories.get(location.repository_id) ?? [];
      ids.push(String(row.id));
      this.registeredRepositories.set(location.repository_id, ids);
    }
    this.updateProjectReferences(this.prepare(`SELECT DISTINCT project FROM tasks WHERE project IS NOT NULL
      UNION SELECT DISTINCT repository_id AS project FROM runs WHERE repository_id IS NOT NULL
      UNION SELECT DISTINCT repository_id AS project FROM conversations WHERE repository_id IS NOT NULL
      UNION SELECT DISTINCT repository_id AS project FROM delegations WHERE repository_id IS NOT NULL`).all().map(row => String(row.project)));
    const resolved = this.prepare("SELECT * FROM api_project_resolution").all()
      .filter(row => previousReferences.get(String(row.id)) !== JSON.stringify(row)).map(row => String(row.id));
    return { upsert, remove: [...previous.keys()], resolved };
  }
  private updateProjectReferences(ids: string[]): void {
    const resolve = this.prepare("INSERT OR REPLACE INTO api_project_resolution VALUES (?, ?, ?)");
    for (const id of new Set(ids)) {
      if (this.prepare("SELECT 1 FROM api_project_resolution WHERE id = ?").get(id)) continue;
      const project = this.prepare("SELECT * FROM api_projects WHERE id = ?").get(id);
      let target = project?.state === "registered" ? id : undefined;
      const repositories = this.registeredRepositories.get(id) ?? [];
      if (!target && repositories.length === 1) target = repositories[0];
      if (!target && project?.root_path) {
        const location = resolveProjectLocation(String(project.root_path));
        const matches = this.registeredRepositories.get(location.repository_id) ?? [];
        if (location.reason !== "missing" && matches.length === 1) target = matches[0];
      }
      resolve.run(id, target ?? id, target ? "registered" : "unregistered");
    }
  }
  private updateSummary(id: string): void {
    const count = Number(this.prepare(`SELECT count(*) AS count FROM api_message_order WHERE conversation_id = ? AND active = 1`).get(id)!.count);
    // 同じ時刻の発言は core の順序で最後を選ぶ。旧い Codex の行の位置は数として比べる。
    const candidates = this.prepare(LATEST_MESSAGE_SQL).all(id, id);
    const latest = (candidates.length ? candidates : this.prepare(FALLBACK_MESSAGE_SQL).all(id, id)).reduce<Record<string, SQLOutputValue> | undefined>((best, row) => !best
        || (Number(row.source_time) - Number(best.source_time)
          || compareEventOrder(String(row.source_event_id ?? ""), String(best.source_event_id ?? "")) || compareEventOrder(String(row.id), String(best.id))) > 0
        ? row : best, undefined);
    const last = latest && { source_ts: latest.source_ts, body: this.prepare("SELECT body FROM messages WHERE id = ?").get(latest.id!)?.body };
    const excerpt = last?.body ? getMessageText(JSON.parse(String(last.body))).slice(0, EXCERPT_LENGTH) : "";
    this.prepare("INSERT OR REPLACE INTO api_conversation_summaries VALUES (?, ?, ?, ?)").run(id, count, last?.source_ts ?? null, excerpt);
  }
  private readList(table: string, ids?: string[], after = "", includeHidden = false): Record<string, unknown>[] {
    const where = (ids ? "WHERE t.id IN (SELECT value FROM json_each(?))" : "WHERE t.id > ?")
      + (table === 'conversations' && !includeHidden ? ` AND (${VISIBLE_CONVERSATION_SQL})` : '');
    const parameter = ids ? JSON.stringify(ids) : after;
    const limit = ids ? "" : `LIMIT ${LIST_PAGE_SIZE}`;
    // 会話の名前と依頼の抜粋は core の投影の値をそのまま配る。画面は本文から名前を導かない。
    // プロジェクトは作業、会話の開始の場所、実行の場所の順に結ぶ。
    if (table === "conversations") {
      const rows = this.prepare(`SELECT t.id, t.provider, t.origin, t.type, t.task_id, t.kit_name, t.user_name, t.created_ts, substr(t.name, 1, ${NAME_LENGTH}) AS name,
      t.name_is_provisional, substr(t.ai_title, 1, ${NAME_LENGTH}) AS ai_title, substr(t.first_request_excerpt, 1, ${NAME_LENGTH}) AS first_request_excerpt, t.cwd,
      coalesce((SELECT json_extract(data, '$.hidden') FROM projection_records WHERE projection = 'conversations' AND entity_id = t.id), 0) AS hidden,
      r.project_id AS project, coalesce(r.state, 'unregistered') AS project_state,
      coalesce(s.message_count, 0) AS message_count, s.last_message_ts, coalesce(s.last_message_excerpt, '') AS last_message_excerpt
      FROM conversations t LEFT JOIN tasks task ON task.id = t.task_id
      LEFT JOIN api_project_resolution r ON r.id = coalesce(task.project, t.repository_id,
        (SELECT repository_id FROM runs WHERE (conversation_id = t.id OR conversation_id IN (
          SELECT id FROM api_conversation_ids WHERE canonical_id = t.id)) AND repository_id IS NOT NULL ORDER BY generation DESC LIMIT 1))
      LEFT JOIN api_conversation_summaries s ON s.id = t.id ${where} ORDER BY t.id ${limit}`).all(parameter);
      return rows.map(row => ({ ...row, pending_inputs: this.inputQueues.get(String(row.id)) ?? [], name_is_provisional: row.name_is_provisional === 1 }));
    }
    // 試行は画面が木と 1 行の要約に使う欄だけを配り、受け入れの出力や報告の本文は配らない。
    if (table === "delegations") return this.prepare(`SELECT t.id, t.request_id, t.kit, t.parent_run_id, t.role, t.title, t.attempt, t.state,
      t.cwd, t.origin, t.parent, t.repository_id, t.provider, t.model, r.project_id AS project,
      CASE WHEN json_valid(t.attempts) THEN (SELECT json_group_array(json_object('attempt', json_extract(a.value, '$.attempt'),
        'state', json_extract(a.value, '$.state'), 'run_id', json_extract(a.value, '$.run_id'),
        'assignment', json_object('model', json_extract(a.value, '$.assignment.model'), 'effort', json_extract(a.value, '$.assignment.effort'),
          'executor', json_extract(a.value, '$.assignment.executor'), 'provider', json_extract(a.value, '$.assignment.provider'))))
        FROM json_each(t.attempts) a) END AS attempts
      FROM delegations t LEFT JOIN api_project_resolution r ON r.id = t.repository_id ${where} ORDER BY t.id ${limit}`).all(parameter);
    if (table === "tasks") return this.prepare(`SELECT t.id, substr(t.name, 1, ${NAME_LENGTH}) AS name, coalesce(r.project_id, t.project) AS project,
      coalesce(r.state, 'unregistered') AS project_state, t.state FROM tasks t
      LEFT JOIN api_project_resolution r ON r.id = t.project ${where} ORDER BY t.id ${limit}`).all(parameter);
    const rows = this.prepare(`SELECT ${LIST_COLUMNS[table] ?? "*"} FROM ${table} t ${where} ORDER BY t.id ${limit}`).all(parameter);
    return table === 'relations' ? rows.map(compactRelation) : rows;
  }
  refresh(): ProjectionPatch | "resync" | undefined {
    const state = this.catchUp();
    this.observation = (state as ProjectionState & { observation?: ObservationProgress }).observation;
    if (state.generation === this.state.generation && state.last_seq === this.state.last_seq) return;
    const previous = this.state;
    const cursor = this.cursor;
    const identities = { conversations: { ...this.identities.conversations }, runs: { ...this.identities.runs } };
    const roots = this.roots;
    const inputQueues = new Map(this.inputQueues);
    const registeredRepositories = new Map(this.registeredRepositories);
    // 読み取りの組を固定し、要約の計算中は書き手を塞がない。
    this.db.exec("BEGIN");
    let stored: ProjectionState;
    let changes: Record<string, SQLOutputValue>[];
    try {
      const row = this.prepare("SELECT last_seq, generation FROM projection_state WHERE id = 1").get()!;
      stored = { ...state, last_seq: Number(row.last_seq), generation: Number(row.generation) };
      changes = this.prepare("SELECT * FROM api_projection_changes WHERE cursor > ? ORDER BY cursor").all(cursor);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    try {
      const patch = this.refreshProjection(stored, changes);
      const nextCursor = Number(changes.at(-1)?.cursor ?? cursor);
      // 成功した組だけ消す。途中の失敗と並行追記は次回に残す。
      this.prepare("DELETE FROM api_projection_changes WHERE cursor <= ?").run(nextCursor);
      this.cursor = nextCursor;
      this.projectBaseline = undefined;
      if (patch === "resync") {
        this.history = []; this.historySizes = []; this.historyBytes = 0;
        this.requiresGeneration = true; this.floor = stored.last_seq;
      } else {
        this.history.push(patch);
        this.historySizes.push(0);
        while (this.history.length > this.limit || this.historyBytes > PATCH_RETENTION_BYTES) {
          this.floor = this.history.shift()!.seq;
          this.historyBytes -= this.historySizes.shift()!;
        }
      }
      this.lastLockLogAt = undefined;
      return patch;
    } catch (error) {
      this.state = previous;
      this.identities = identities;
      this.roots = roots;
      this.inputQueues = inputQueues;
      this.registeredRepositories = registeredRepositories;
      if (error instanceof Error && "errcode" in error && (Number(error.errcode) & 0xff) === 5) {
        const now = Date.now();
        if (this.lastLockLogAt === undefined || now - this.lastLockLogAt >= LOCK_LOG_INTERVAL_MS) {
          console.error("Projection refresh skipped: database is locked");
          this.lastLockLogAt = now;
        }
        return;
      }
      this.lastLockLogAt = undefined;
      throw error;
    }
  }
  serializePatch(patch: ProjectionPatch): string {
    let text = this.serialized.get(patch);
    if (text === undefined) {
      const { detail, ...message } = patch;
      text = JSON.stringify(message);
      this.serialized.set(patch, text);
      this.recordPatchBytes(patch, text);
    }
    return text;
  }
  recordPatchBytes(patch: ProjectionPatch, text: string): void {
    const index = this.history.indexOf(patch);
    if (index < 0) return;
    const bytes = Buffer.byteLength(text);
    if (bytes <= this.historySizes[index]) return;
    this.historyBytes += bytes - this.historySizes[index];
    this.historySizes[index] = bytes;
    while (this.historyBytes > PATCH_RETENTION_BYTES) {
      this.floor = this.history.shift()!.seq;
      this.historyBytes -= this.historySizes.shift()!;
    }
  }
  private refreshProjection(state: ProjectionState, changes: Record<string, SQLOutputValue>[]): ProjectionPatch | "resync" {
    const previous = this.state;
    this.state = state;
    const groups = new Map<string, Set<string>>();
    const conversations = new Set<string>();
    const membershipConversations: Record<string, string[]> = {};
    for (const row of changes) {
      const table = String(row.table_name);
      const ids = groups.get(table) ?? new Set<string>();
      ids.add(String(row.id)); groups.set(table, ids);
      if (row.conversation_id) conversations.add(String(row.conversation_id));
      if (table === "message_memberships" && row.conversation_id) {
        (membershipConversations[String(row.id)] ??= []).push(String(row.conversation_id));
      }
    }
    const messages = [...groups.get("messages") ?? []];
    for (const row of this.prepare(`SELECT DISTINCT conversation_id FROM message_memberships
      WHERE message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(messages))) conversations.add(String(row.conversation_id));
    for (const id of conversations) this.updateSummary(id);
    const identityChanged = !!this.prepare("SELECT 1 FROM facts WHERE seq > ? AND seq <= ? AND (kind GLOB 'conversation.*' OR kind = 'run.created') AND kind != 'conversation.input_queue_changed' LIMIT 1").get(previous.last_seq, state.last_seq);
    const identities = identityChanged || state.generation !== previous.generation
      ? this.updateIdentities(state.generation === previous.generation ? previous.last_seq : undefined) : undefined;
    const projectFactsChanged = !!this.prepare("SELECT 1 FROM facts WHERE seq > ? AND seq <= ? AND kind LIKE 'project.%' LIMIT 1").get(previous.last_seq, state.last_seq);
    const projectChanges = projectFactsChanged || state.generation !== previous.generation ? this.updateProjects() : undefined;
    if (projectChanges?.resolved.length) {
      const tasks = groups.get("tasks") ?? new Set<string>();
      for (const row of this.prepare("SELECT id FROM tasks WHERE project IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(projectChanges.resolved))) tasks.add(String(row.id));
      groups.set("tasks", tasks);
    }
    if (!projectChanges && ["tasks", "runs", "conversations", "delegations"].some(table => groups.has(table))) this.updateProjectReferences(this.prepare(`
      SELECT project FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND project IS NOT NULL
      UNION SELECT repository_id AS project FROM runs WHERE id IN (SELECT value FROM json_each(?)) AND repository_id IS NOT NULL
      UNION SELECT repository_id AS project FROM conversations WHERE id IN (SELECT value FROM json_each(?)) AND repository_id IS NOT NULL
      UNION SELECT repository_id AS project FROM delegations WHERE id IN (SELECT value FROM json_each(?)) AND repository_id IS NOT NULL`)
      .all(...["tasks", "runs", "conversations", "delegations"].map(table => JSON.stringify([...groups.get(table) ?? []])))
      .map(row => String(row.project)));
    const ids = groups.get("conversations") ?? new Set<string>();
    for (const id of conversations) ids.add(id);
    for (const row of this.prepare("SELECT conversation_id FROM runs WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify([...groups.get("runs") ?? []]))) {
      const id = String(row.conversation_id);
      ids.add(this.identities.conversations[id] ?? id);
    }
    if (projectChanges?.resolved.length) for (const row of this.prepare(`SELECT DISTINCT conversation_id FROM runs
      WHERE repository_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(projectChanges.resolved))) {
      const id = String(row.conversation_id);
      ids.add(this.conversationId(id));
    }
    if (groups.has("tasks")) for (const row of this.prepare("SELECT id FROM conversations WHERE task_id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...groups.get("tasks")!]))) ids.add(String(row.id));
    if (projectChanges?.resolved.length) {
      for (const row of this.prepare("SELECT id FROM conversations WHERE repository_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(projectChanges.resolved))) ids.add(String(row.id));
      const delegations = groups.get("delegations") ?? new Set<string>();
      for (const row of this.prepare("SELECT id FROM delegations WHERE repository_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(projectChanges.resolved))) delegations.add(String(row.id));
      if (delegations.size) groups.set("delegations", delegations);
    }
    const queueIds = new Set<string>();
    for (const row of this.prepare(`SELECT DISTINCT substr(subject, 14) AS id FROM facts
      WHERE seq > ? AND seq <= ? AND kind IN ('conversation.input_queue_changed', 'conversation.hidden')`).all(previous.last_seq, state.last_seq)) {
      const id = this.conversationId(String(row.id));
      ids.add(id); queueIds.add(id);
    }
    // 待ち行列が変わった会話だけ読み直し、通常の一覧取得にはレコード表を持ち込まない。
    for (const id of ids) if (this.inputQueues.has(id)) queueIds.add(id);
    const resetQueues = state.generation !== previous.generation || state.last_seq < previous.last_seq
      || Object.keys(identities?.conversations ?? {}).length > 0;
    this.updateInputQueues(resetQueues ? undefined : [...queueIds]);
    groups.set("conversations", ids);
    if (state.generation !== previous.generation || state.last_seq < previous.last_seq) {
      this.roots = this.readRoots();
      return "resync";
    }
    const patch: ProjectionPatch = { type: "patch", from_seq: previous.last_seq, seq: state.last_seq,
      generation: state.generation, changes: {}, ...(identities ? { identities } : {}),
      detail: { messages, memberships: [...groups.get("message_memberships") ?? []], conversations: [...conversations],
        membership_conversations: membershipConversations } };
    for (const table of LIST_TABLES) {
      const changed = [...groups.get(table) ?? []];
      if (!changed.length) continue;
      const upsert = this.readList(table, changed);
      const current = new Set(upsert.map(row => String(row.id)));
      patch.changes[table] = { upsert, remove: changed.filter(id => !current.has(id)) };
    }
    if (projectChanges && (projectChanges.upsert.length || projectChanges.remove.length)) {
      patch.changes.projects = { upsert: projectChanges.upsert, remove: projectChanges.remove };
    }
    if (["conversations", "relations", "runs", "tasks", "messages", "message_memberships"].some(table => groups.has(table))) {
      const previousRoots = new Map(this.roots.map(row => [row.id, row]));
      const bindings = (roots: RootProjection[]) => JSON.stringify(roots.map(({ id, name, project }) => [id, name, project]));
      const previousBindings = bindings(this.roots);
      this.roots = this.readRoots();
      const current = new Set(this.roots.map(row => row.id));
      const rootChanges = { upsert: this.roots.filter(row => JSON.stringify(row) !== JSON.stringify(previousRoots.get(row.id))) as unknown as Record<string, unknown>[],
        remove: [...previousRoots.keys()].filter(id => !current.has(id)) };
      if (rootChanges.upsert.length || rootChanges.remove.length) patch.changes.roots = rootChanges;
      if (previousBindings !== bindings(this.roots)) {
        const all: Record<string, unknown>[] = [];
        let after = "";
        for (;;) {
          const page = this.readList("delegations", undefined, after);
          all.push(...page);
          if (page.length < LIST_PAGE_SIZE) break;
          after = String(page.at(-1)!.id);
        }
        if (all.length) patch.changes.delegations = { upsert: all, remove: patch.changes.delegations?.remove ?? [] };
      }
    }
    if (patch.changes.delegations) patch.changes.delegations.upsert = this.rootDelegations(patch.changes.delegations.upsert);
    const referenced = this.readReferencedIdentities(Object.values(patch.changes).flatMap(change => change.upsert));
    if (identities || Object.keys(referenced.conversations).length || Object.keys(referenced.runs).length) {
      // 対応そのものの変更は省かず、配信済みの独自別名や自己対応への訂正を上書きする。
      patch.identities = { conversations: { ...referenced.conversations, ...identities?.conversations },
        runs: { ...referenced.runs, ...identities?.runs } };
    }
    return patch;
  }
  replay(seq: number, generation?: number): ProjectionPatch[] | undefined {
    if (this.requiresGeneration && generation === undefined) return;
    if (seq < this.floor || seq > this.state.last_seq || generation !== undefined && generation !== this.state.generation) return;
    return this.history.filter(patch => patch.seq > seq);
  }
  private readRoots(): RootProjection[] {
    const conversations: RootConversation[] = [];
    let after = "";
    for (;;) {
      const page = this.readList("conversations", undefined, after, true);
      // 根の投影に使わない一覧の列と抜粋を、全会話分の中間配列へ複製しない。
      for (const row of page) conversations.push({ id: String(row.id), type: row.type as string, hidden: Boolean(row.hidden),
        user_name: row.user_name as string | null, name: row.name as string | null, kit_name: row.kit_name as string | null, project: row.project as string | null,
        created_ts: row.created_ts as string | null, last_activity_ts: row.last_message_ts as string | null, state: "unknown" });
      if (page.length < LIST_PAGE_SIZE) break;
      after = String(page.at(-1)!.id);
    }
    const latest = new Map<string, Record<string, unknown>>();
    // 同世代の割れでは既知の状態を優先する。新世代の unknown は古い状態で補わない。
    for (const row of this.prepare("SELECT conversation_id, generation, state, last_evidence_ts, ended_ts, started_ts FROM runs ORDER BY generation, state != 'unknown', id").iterate()) {
      latest.set(this.conversationId(String(row.conversation_id)), row);
    }
    for (const row of conversations) {
      const run = latest.get(row.id);
      row.state = run ? String(run.state) : "unknown";
      const ts = run?.last_evidence_ts ?? run?.ended_ts ?? run?.started_ts;
      if (typeof ts === "string" && ts > (row.last_activity_ts ?? "")) row.last_activity_ts = ts;
    }
    // 名前を持つ subject の履歴だけを読む。解除の null と部分訂正の継承も残す。
    const facts = decodeFacts(this.prepare(`SELECT * FROM facts WHERE subject IN (
      SELECT subject FROM facts WHERE kind GLOB 'conversation.*'
        AND json_type(payload, '$.user_name') IS NOT NULL AND seq <= ?)
      AND seq <= ? AND kind GLOB 'conversation.*' AND kind != 'conversation.input_queue_changed'`)
      .all(this.state.last_seq, this.state.last_seq));
    return projectRoots(conversations, this.prepare("SELECT from_id, to_id, type, active, confidence FROM relations").all() as { from_id: string; to_id: string; type: string; active: number; confidence: string }[], facts);
  }
  private rootDelegations(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map(row => {
      const kit = typeof row.kit === "string" ? JSON.parse(row.kit) : row.kit;
      const linked = connectRootDelegations([{ kit,
        repository_id: typeof row.project === "string" ? row.project : typeof row.repository_id === "string" ? row.repository_id : undefined }], this.roots)[0];
      return { ...row, kit, root_id: linked.root_id };
    });
  }
  private readReferencedIdentities(rows: Record<string, unknown>[]): ScreenIdentities {
    const identities: ScreenIdentities = { conversations: {}, runs: {} };
    const add = (id: unknown) => {
      if (typeof id !== "string") return;
      if (id in this.identities.conversations) identities.conversations[id] = this.identities.conversations[id];
      if (id in this.identities.runs) {
        identities.runs[id] = this.identities.runs[id];
        const conversation = /^(.*):\d+$/.exec(id)?.[1];
        if (conversation && conversation in this.identities.conversations) identities.conversations[conversation] = this.identities.conversations[conversation];
      }
    };
    for (const row of rows) {
      for (const key of ["id", "conversation_id", "run_id", "parent_run_id", "from_id", "to_id", "current_conversation_id"]) add(row[key]);
      if (typeof row.id === 'string' && row.id.startsWith('[')) {
        const parts = readRelationParts(row.id);
        if (parts) { add(row.from_id ?? parts[1]); add(row.to_id ?? parts[2]); }
      }
      for (const id of Array.isArray(row.conversation_ids) ? row.conversation_ids : []) add(id);
      const attempts = typeof row.attempts === "string" ? JSON.parse(row.attempts) : row.attempts;
      for (const attempt of Array.isArray(attempts) ? attempts : []) add(attempt.run_id);
    }
    return compactScreenIdentities(identities);
  }
  hasRoot(id: string): boolean { return this.roots.some(root => root.id === id); }
  snapshot() {
    const projection = Object.fromEntries(LIST_TABLES.map(table => [table, this.readList(table)]));
    projection.roots = this.roots.slice(0, LIST_PAGE_SIZE) as unknown as Record<string, unknown>[];
    projection.delegations = this.rootDelegations(projection.delegations);
    projection.projects = this.prepare("SELECT * FROM api_projects ORDER BY id").all();
    const pages = Object.fromEntries(LIST_TABLES.map(table => [table, {
      total: Number(this.prepare(`SELECT count(*) AS count FROM ${table} t${table === 'conversations' ? ` WHERE ${VISIBLE_CONVERSATION_SQL}` : ''}`).get()!.count),
      next: projection[table].length === LIST_PAGE_SIZE ? projection[table].at(-1)!.id : null,
    }]));
    pages.roots = { total: this.roots.length, next: this.roots.length >= LIST_PAGE_SIZE ? this.roots[LIST_PAGE_SIZE - 1].id : null };
    const identities = compactScreenIdentities(this.identities);
    return { seq: this.state.last_seq, generation: this.state.generation, projection, pages, identities,
      ...(this.observation ? { observation: this.observation } : {}) };
  }
  list(table: string, after = "") {
    if (table === "roots") {
      const rows = this.roots.filter(row => row.id > after).slice(0, LIST_PAGE_SIZE);
      return { seq: this.state.last_seq, generation: this.state.generation, rows: rows as unknown as Record<string, unknown>[],
        identities: this.readReferencedIdentities(rows as unknown as Record<string, unknown>[]), next: rows.length === LIST_PAGE_SIZE ? rows.at(-1)!.id : null };
    }
    if (!(LIST_TABLES as readonly string[]).includes(table)) throw new RangeError("Invalid list table");
    const page = this.readList(table, undefined, after);
    const rows = table === "delegations" ? this.rootDelegations(page) : page;
    return { seq: this.state.last_seq, generation: this.state.generation, rows,
      identities: this.readReferencedIdentities(rows),
      next: rows.length === LIST_PAGE_SIZE ? rows.at(-1)!.id : null };
  }
  conversation(id: string, after = "", window?: { latest?: boolean; before?: string | MessageCursor; message?: string; edits?: boolean }) {
    id = this.conversationId(id);
    let hasOlder = false;
    let olderCursor: MessageCursor | null = null;
    let messages;
    if (window?.latest || window?.before || window?.message) {
      // 並べるのは識別子と時刻だけ。本文は選んだ窓だけを読む。
      const ordered = this.prepare(`SELECT m.id, m.source_ts, m.source_event_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
        WHERE mm.conversation_id = ? AND mm.active = 1`).all(id).map(row => ({ id: String(row.id), source_ts: String(row.source_ts ?? ''), source_event_id: String(row.source_event_id ?? ''),
          eventOrder: encodeEventOrder(String(row.source_event_id ?? '')), idOrder: encodeEventOrder(String(row.id)),
        })).sort((a, b) =>
        String(a.source_ts ?? '').localeCompare(String(b.source_ts ?? ''))
        || (a.eventOrder < b.eventOrder ? -1 : a.eventOrder > b.eventOrder ? 1 : 0)
        || (a.idOrder < b.idOrder ? -1 : a.idOrder > b.idOrder ? 1 : 0));
      const anchor = window.before ? readMessageCursor(window.before) : window.message;
      // 旧形式も所属から切り離して位置を解決する。新形式は取得時の位置を保持する。
      const cursor = typeof anchor === 'string' ? this.prepare(`SELECT id, source_ts, source_event_id FROM messages WHERE id = ?`).get(anchor) as MessageCursor | undefined : anchor;
      const index = cursor ? ordered.findIndex(row => window.message
        ? compareMessageCursors(row, cursor) > 0 : compareMessageCursors(row, cursor) >= 0) : -1;
      const end = index < 0 ? ordered.length : index;
      const start = Math.max(0, end - DETAIL_PAGE_SIZE);
      hasOlder = start > 0;
      const first = ordered[start];
      if (first && start < end) olderCursor = { source_ts: first.source_ts, source_event_id: first.source_event_id, id: first.id };
      const ids = ordered.slice(start, end).map(row => row.id);
      messages = this.prepare(`SELECT m.*, mm.id AS membership_id FROM json_each(?) selected JOIN messages m ON m.id = selected.value
        JOIN message_memberships mm ON mm.message_id = m.id AND mm.conversation_id = ? AND mm.active = 1
        ORDER BY CAST(selected.key AS INTEGER)`).all(JSON.stringify(ids), id);
    } else {
      messages = this.prepare(`SELECT m.*, mm.id AS membership_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
        WHERE mm.conversation_id = ? AND mm.active = 1 AND m.id > ?
        ${window?.edits ? `AND EXISTS (SELECT 1 FROM json_each(
          CASE WHEN json_valid(m.body) AND json_type(m.body) = 'array' THEN m.body ELSE '[]' END) block
          WHERE json_extract(CASE WHEN block.type = 'object' THEN block.value ELSE '{}' END, '$.type') = 'tool_use'
          AND (json_extract(block.value, '$.name') IN ('Edit', 'Write', 'MultiEdit')
            OR json_extract(block.value, '$.input') LIKE '%*** Begin Patch%'))` : ''}
        ORDER BY m.id LIMIT ?`).all(id, after, DETAIL_PAGE_SIZE);
    }
    const memberships = messages.map(row => ({ id: row.membership_id, message_id: row.id, conversation_id: id, active: 1 }));
    return { seq: this.state.last_seq, generation: this.state.generation,
      projection: { conversations: this.readList("conversations", [id], "", true),
        messages: messages.map(({ membership_id, ...row }) => row), message_memberships: memberships },
      hasOlder, olderCursor, next: window?.latest || window?.before || window?.message ? null : messages.length === DETAIL_PAGE_SIZE ? messages.at(-1)!.id : null };
  }
  conversationId(id: string): string { return this.identities.conversations[id] ?? id; }
  scopePatch(patch: ProjectionPatch, opened: Set<string>): ProjectionPatch {
    const { detail, ...output } = patch;
    if (!detail || !opened.size) return output;
    opened = new Set([...opened].map(id => this.identities.conversations[id] ?? id));
    const encoded = JSON.stringify([...opened]);
    const changedMessages = JSON.stringify(detail.messages);
    const changedMemberships = JSON.stringify(detail.memberships);
    const messages = this.prepare(`SELECT DISTINCT m.* FROM messages m JOIN message_memberships mm ON mm.message_id = m.id
      WHERE mm.conversation_id IN (SELECT value FROM json_each(?)) AND mm.active = 1
      AND (m.id IN (SELECT value FROM json_each(?)) OR mm.id IN (SELECT value FROM json_each(?)))`).all(encoded, changedMessages, changedMemberships);
    const memberships = this.prepare(`SELECT * FROM message_memberships WHERE conversation_id IN (SELECT value FROM json_each(?))
      AND id IN (SELECT value FROM json_each(?))`).all(encoded, changedMemberships);
    const existing = new Set(memberships.map(row => String(row.id)));
    const affected = detail.conversations.some(id => opened.has(this.conversationId(id)));
    output.changes = { ...output.changes };
    const removedMessages = affected ? this.prepare(`SELECT value AS id FROM json_each(?)
      WHERE NOT EXISTS (SELECT 1 FROM messages WHERE id = value)`).all(changedMessages).map(row => String(row.id)) : [];
    if (messages.length || removedMessages.length) output.changes.messages = { upsert: messages, remove: removedMessages };
    const removedMemberships = detail.memberships.filter(id => !existing.has(id)
      && detail.membership_conversations[id]?.some(conversation => opened.has(this.conversationId(conversation))));
    if (memberships.length || removedMemberships.length) output.changes.message_memberships = { upsert: memberships, remove: removedMemberships };
    const identities = this.readReferencedIdentities([...messages, ...memberships]);
    if (Object.keys(identities.conversations).length || Object.keys(identities.runs).length) {
      output.identities = { conversations: { ...output.identities?.conversations, ...identities.conversations },
        runs: { ...output.identities?.runs, ...identities.runs } };
    }
    return output;
  }
  runConversation(runId: string): string | undefined {
    const row = this.prepare(`SELECT r.conversation_id FROM runs r LEFT JOIN run_subjects s
      ON s.conversation_id = r.conversation_id AND s.generation = r.generation
      WHERE r.id = ? OR s.subject_id = ? ORDER BY r.generation DESC LIMIT 1`).get(runId, runId);
    if (!row?.conversation_id) return;
    const id = String(row.conversation_id);
    return this.identities.conversations[id] ?? id;
  }
  close(): void { this.db.close(); }
}
