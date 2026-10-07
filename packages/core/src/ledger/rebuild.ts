import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Fact, JsonValue } from "./facts.ts";
import {
  project, serializeValue, projectNames, projectConversations, projectRelations,
  projectRuns, projectConnections, projectMessages, projectDelegations,
  projectArtifacts, projectApprovals, projectFindings, projectConversationIds,
} from "./projections/index.ts";
import { PROJECTION_ENTITIES, readNativeReference } from "./projections/dependencies.ts";
import { encodeNameOrder, extractProvisionalName } from "./projections/conversations.ts";
import type { ProjectedMessage } from "./projections/messages.ts";
import type { Projection } from "./projections/index.ts";
import { initializeRunnerProjection, forgetRunnerProjection, RECORD_ENTITIES } from "./projections/storage.ts";
import { projectEntityRecords } from "./projections/delegations.ts";
import { projectInitial } from "./projections/initial.ts";
import { refreshSearch } from "./search.ts";

export const PROJECTION_TABLES = [
  "tasks", "conversations", "relations", "runs", "connections", "messages",
  "delegations", "artifacts", "aliases", "approvals", "findings", "message_memberships",
] as const satisfies readonly (keyof Projection)[];
type ProjectionTable = typeof PROJECTION_TABLES[number];

// 表ごとの純粋な投影だけを実行し、依存先の補助表は書き換えない。
const PROJECT_TABLE = {
  tasks: (facts: readonly Fact[]) => projectNames(facts).tasks,
  conversations: (facts: readonly Fact[]) => projectConversations(facts).conversations,
  relations: projectRelations,
  runs: projectRuns,
  connections: projectConnections,
  messages: (facts: readonly Fact[]) => projectMessages(facts).messages,
  delegations: projectDelegations,
  artifacts: projectArtifacts,
  aliases: (facts: readonly Fact[]) => projectNames(facts).aliases,
  approvals: projectApprovals,
  findings: projectFindings,
  message_memberships: (facts: readonly Fact[]) => projectMessages(facts).message_memberships,
} as const;

const STATEMENTS = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function prepare(ledger: DatabaseSync, sql: string): StatementSync {
  let statements = STATEMENTS.get(ledger);
  if (!statements) { statements = new Map(); STATEMENTS.set(ledger, statements); }
  let statement = statements.get(sql);
  if (!statement) { statement = ledger.prepare(sql); statements.set(sql, statement); }
  return statement;
}

const JSON_COLUMNS = new Set([
  "evidence", "end_evidence", "last_evidence", "tool_output",
  "accept", "scope", "constraints", "result", "attempts", "untracked",
  "verification", "commits", "available_decisions", "request", "launch", "parent",
]);

export interface ProjectionState {
  generation: number;
  last_seq: number;
}

function readState(ledger: DatabaseSync): ProjectionState {
  const row = prepare(ledger, "SELECT generation, last_seq FROM projection_state WHERE id = 1").get();
  if (!row) throw new Error("projection_state がありません");
  return { generation: Number(row.generation), last_seq: Number(row.last_seq) };
}

function decodeFact(row: Record<string, unknown>): Fact {
  return { ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact;
}

function readFacts(ledger: DatabaseSync, afterSeq = 0): Fact[] {
  return prepare(ledger, "SELECT * FROM facts WHERE seq > ? ORDER BY seq")
    .all(afterSeq).map(decodeFact);
}

// 変更は提供先へ、再投影の入力は参照先へ辿る。共有の会話から無関係の実行には広げない。
function expandSubjects(
  ledger: DatabaseSync, table: ProjectionTable, subjects: Set<string>,
  direction: "needs" | "offers", throughSeq: number,
): Set<string> {
  const result = new Set(subjects);
  // DISTINCT のために SQLite が全表を先に走査しないよう、起点を先に固定する。
  const targets = prepare(ledger, `SELECT DISTINCT target.subject
    FROM fact_projection_dependencies AS origin
    CROSS JOIN fact_projection_dependencies AS target INDEXED BY fact_projection_dependency_lookup
      ON target.projection = origin.projection AND target.key = origin.key
    WHERE origin.projection = ? AND origin.subject IN (SELECT value FROM json_each(?)) AND origin.direction = ?
      AND target.direction = ? AND origin.seq <= ? AND target.seq <= ?`);
  const targetDirection = direction === "needs" ? "offers" : "needs";
  let frontier = [...subjects];
  while (frontier.length) {
    const next: string[] = [];
    for (const target of targets.all(table, JSON.stringify(frontier), direction, targetDirection, throughSeq, throughSeq)) {
      const subject = String(target.subject);
      if (!result.has(subject)) { result.add(subject); next.push(subject); }
    }
    frontier = next;
  }
  return result;
}

function readSubjectFacts(ledger: DatabaseSync, subjects: Set<string>, throughSeq: number): Fact[] {
  return prepare(ledger, `SELECT * FROM facts
    WHERE subject IN (SELECT value FROM json_each(?)) AND seq <= ? ORDER BY seq`)
    .all(JSON.stringify([...subjects]), throughSeq).map(decodeFact);
}

// 関係の同一性の候補は起点の別名までに限り、委譲の木全体へ再帰的に広げない。
function includeRelationPeers(
  ledger: DatabaseSync, subjects: Set<string>, facts: readonly Fact[], lastSeq: number, throughSeq: number,
): Set<string> {
  const identities = [projectConversationIds(facts), projectConversationIds(facts.filter((fact) => fact.seq <= lastSeq))];
  const sources = new Set<string>();
  for (const fact of facts) {
    const payload = fact.payload as { from_id?: string } | null;
    if (!fact.kind.startsWith("relation.") || typeof payload?.from_id !== "string") continue;
    for (const ids of identities) sources.add(ids.get(payload.from_id) ?? payload.from_id);
  }
  const references = new Set(sources);
  for (const ids of identities) {
    for (const [subject, id] of ids) if (sources.has(id)) references.add(subject);
  }
  const candidates = prepare(ledger, `SELECT DISTINCT subject FROM fact_projection_dependencies
    WHERE projection = 'relations' AND direction = 'offers' AND key = ? AND seq <= ?`);
  for (const reference of references) {
    for (const row of candidates.all(`relation-from:${reference}`, throughSeq)) subjects.add(String(row.subject));
  }
  return expandSubjects(ledger, "relations", subjects, "needs", throughSeq);
}

function encodeValue(table: string, column: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (JSON_COLUMNS.has(column) || (table === "messages" && column === "body")
    || (table === "delegations" && column === "origin")) return serializeValue(value as JsonValue);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || typeof value === "number") return value;
  throw new TypeError(`投影の列 ${column} の値が未対応です`);
}

function writeRows(
  ledger: DatabaseSync, table: ProjectionTable, rows: readonly { id: string }[],
  previousIds: Iterable<string> = [],
): void {
  const columns = prepare(ledger, `PRAGMA table_info(${table})`).all().map((row) => String(row.name));
  const read = prepare(ledger, `SELECT * FROM ${table} WHERE id = ?`);
  const insert = prepare(ledger, `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
  const remaining = new Set(previousIds);
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    const values = columns.map((column) => encodeValue(table, column, record[column]));
    const previous = remaining.has(row.id) ? read.get(row.id) : undefined;
    if (!previous || columns.some((column, index) => previous[column] !== values[index])) insert.run(...values);
    const serialized = JSON.stringify(record);
    if (!previous || prepare(ledger, "SELECT data FROM projection_records WHERE projection = ? AND entity_id = ?").get(table, row.id)?.data !== serialized) {
      prepare(ledger, "INSERT OR REPLACE INTO projection_records VALUES (?, ?, ?)").run(table, row.id, serialized);
    }
    remaining.delete(row.id);
    if (table === "delegations") {
      prepare(ledger, "DELETE FROM delegation_runs WHERE delegation_id = ?").run(row.id);
      for (const attempt of (record.attempts ?? []) as { run_id?: string }[]) {
        if (attempt.run_id) prepare(ledger, "INSERT OR IGNORE INTO delegation_runs VALUES (?, ?)").run(attempt.run_id, row.id);
      }
    }
  }
  const remove = prepare(ledger, `DELETE FROM ${table} WHERE id = ?`);
  for (const id of remaining) {
    remove.run(id);
    prepare(ledger, "DELETE FROM projection_records WHERE projection = ? AND entity_id = ?").run(table, id);
    if (table === "delegations") prepare(ledger, "DELETE FROM delegation_runs WHERE delegation_id = ?").run(id);
  }
}

// 最古の有効な本文候補は索引で選ぶ。会話の履歴全体を投影の入力に戻さない。
function refreshNameCandidates(ledger: DatabaseSync, ids: Set<string>, conversations: Set<string>): void {
  const encoded = JSON.stringify([...ids]);
  for (const row of prepare(ledger, `SELECT conversation_id FROM conversation_name_candidates
    WHERE id IN (SELECT value FROM json_each(?))`).all(encoded)) conversations.add(String(row.conversation_id));
  prepare(ledger, "DELETE FROM conversation_name_candidates WHERE id IN (SELECT value FROM json_each(?))").run(encoded);
  prepare(ledger, `INSERT INTO conversation_name_candidates
    SELECT m.id, m.conversation_id, m.message_id, n.source_time, n.source_event_id, n.name, n.message_order
    FROM message_memberships m JOIN message_name_inputs n ON n.id = m.message_id
    WHERE m.id IN (SELECT value FROM json_each(?)) AND m.active = 1
      AND m.conversation_id IS NOT NULL AND n.name <> ''`).run(encoded);
  for (const row of prepare(ledger, `SELECT conversation_id FROM message_memberships
    WHERE id IN (SELECT value FROM json_each(?)) AND conversation_id IS NOT NULL`).all(encoded)) conversations.add(String(row.conversation_id));
}

function writeMessageNames(ledger: DatabaseSync, messages: readonly ProjectedMessage[], previousIds: Iterable<string>): void {
  const remove = prepare(ledger, "DELETE FROM message_name_inputs WHERE id = ?");
  for (const id of previousIds) remove.run(id);
  const insert = prepare(ledger, "INSERT OR REPLACE INTO message_name_inputs VALUES (?, ?, ?, ?, ?)");
  for (const message of messages) {
    insert.run(message.id, Date.parse(message.source_ts), encodeNameOrder(message.source_event_id),
      extractProvisionalName(message.body), encodeNameOrder(message.id));
  }
}

function readConversationNames(ledger: DatabaseSync, facts: readonly Fact[]): Map<string, string> {
  const names = new Map<string, string>();
  const first = prepare(ledger, `SELECT name FROM conversation_name_candidates
    WHERE conversation_id = ? ORDER BY source_time, source_event_id, message_order LIMIT 1`);
  for (const id of projectConversationIds(facts).values()) {
    const row = first.get(id);
    if (row) names.set(id, String(row.name));
  }
  return names;
}

function applyAffected(ledger: DatabaseSync, added: readonly Fact[], lastSeq: number): void {
  const throughSeq = added.at(-1)!.seq;
  const changed = new Set(added.map((fact) => fact.kind.split(".")[0]));
  const nameConversations = new Set<string>();
  const order = ["messages", "message_memberships", ...PROJECTION_TABLES.filter((table) => table !== "messages" && table !== "message_memberships")] as const;
  for (const table of order) {
    const entities: readonly string[] = PROJECTION_ENTITIES[table];
    if (!entities.some((entity) => changed.has(entity)) && !(table === "conversations" && nameConversations.size)) continue;
    const seeds = new Set<string>(added.filter((fact) => entities.includes(fact.kind.split(".")[0]))
      .map((fact) => fact.subject));
    if (table === "conversations") {
      const keys = [...nameConversations].flatMap((id) => {
        const keys = [`conversation:${id}`];
        const native = readNativeReference(id);
        if (native !== undefined) keys.push(`conversation-native:${native}`);
        return keys;
      });
      for (const row of prepare(ledger, `SELECT DISTINCT subject FROM fact_projection_dependencies
        WHERE projection = 'conversations' AND direction = 'offers'
          AND key IN (SELECT value FROM json_each(?)) AND seq <= ?`).all(JSON.stringify(keys), throughSeq)) seeds.add(String(row.subject));
    }
    const affected = expandSubjects(ledger, table, seeds, "offers", throughSeq);
    const entity = PROJECTION_ENTITIES[table][0];
    if (![...affected].some((subject) => subject.startsWith(`${entity}:`))) continue;
    let subjects = expandSubjects(ledger, table, affected, "needs", throughSeq);
    let facts = readSubjectFacts(ledger, subjects, throughSeq);
    if (table === "relations") {
      subjects = includeRelationPeers(ledger, subjects, facts, lastSeq, throughSeq);
      facts = readSubjectFacts(ledger, subjects, throughSeq);
    }
    const previous = PROJECT_TABLE[table](facts.filter((fact) => fact.seq <= lastSeq));
    const next = table === "conversations"
      ? projectConversations(facts, readConversationNames(ledger, facts)).conversations
      : PROJECT_TABLE[table](facts);
    writeRows(ledger, table, next, previous.map((row) => row.id));
    if (table === "messages") {
      const ids = new Set([...previous, ...next].map((row) => row.id));
      writeMessageNames(ledger, next as ProjectedMessage[], previous.map((row) => row.id));
      const memberships = prepare(ledger, `SELECT id FROM message_memberships
        WHERE message_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...ids]));
      refreshNameCandidates(ledger, new Set(memberships.map((row) => String(row.id))), nameConversations);
    }
    if (table === "message_memberships") {
      refreshNameCandidates(ledger, new Set([...previous, ...next].map((row) => row.id)), nameConversations);
    }
  }
}

function writeEntityRecords(ledger: DatabaseSync, facts: readonly Fact[], subjects?: Set<string>): void {
  const insert = prepare(ledger, "INSERT OR REPLACE INTO entity_records(entity, id, data, last_seq) VALUES (?, ?, ?, ?)");
  for (const entity of RECORD_ENTITIES) {
    const selected = facts.filter((fact) => fact.subject.startsWith(entity + ":"));
    const positions = new Map<string, number>();
    for (const fact of selected) positions.set(fact.subject.slice(entity.length + 1), Math.max(positions.get(fact.subject.slice(entity.length + 1)) ?? 0, fact.seq));
    if (subjects) for (const subject of subjects) {
      if (subject.startsWith(entity + ":")) prepare(ledger, "DELETE FROM entity_records WHERE entity = ? AND id = ?").run(entity, subject.slice(entity.length + 1));
    }
    for (const row of projectEntityRecords(selected, entity)) insert.run(entity, row.id, JSON.stringify(row), positions.get(row.id)!);
  }
}

function updateProjection(ledger: DatabaseSync, sinceSeq?: number, initial = false): ProjectionState {
  ledger.exec("BEGIN IMMEDIATE");
  try {
    const state = readState(ledger);
    if (sinceSeq !== undefined && sinceSeq > state.last_seq) {
      throw new RangeError("未反映の事実を飛ばすことはできません");
    }
    if (initializeRunnerProjection(ledger) && (state.generation > 0 || state.last_seq > 0)) sinceSeq = undefined;
    // 初回の二次索引は、共通スキーマを用意してから同じ取引内で一括構築する。
    const indexes = initial ? ledger.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
      AND tbl_name IN ('message_memberships', 'conversation_name_candidates', 'search_documents', 'search_body_sources')`).all() : [];
    for (const index of indexes) ledger.exec(`DROP INDEX "${String(index.name).replaceAll('"', '""')}"`);
    const added = readFacts(ledger, sinceSeq === undefined ? 0 : state.last_seq);
    if (sinceSeq === undefined || added.length > 0) {
      if (sinceSeq === undefined) {
        const projection = initial ? projectInitial(added) : project(added);
        ledger.exec("DELETE FROM projection_records; DELETE FROM entity_records; DELETE FROM delegation_runs; DELETE FROM run_commit_results; DELETE FROM command_receipts; DELETE FROM run_subjects");
        writeEntityRecords(ledger, added);
        ledger.exec("DELETE FROM message_name_inputs; DELETE FROM conversation_name_candidates");
        for (const table of PROJECTION_TABLES) {
          ledger.exec(`DELETE FROM ${table}`);
          writeRows(ledger, table, projection[table]);
        }
        writeMessageNames(ledger, projection.messages, []);
        refreshNameCandidates(ledger, new Set(projection.message_memberships.map((row) => row.id)), new Set());
      } else {
        applyAffected(ledger, added, state.last_seq);
        const subjects = new Set(added.map((fact) => fact.subject));
        writeEntityRecords(ledger, readSubjectFacts(ledger, subjects, added.at(-1)!.seq), subjects);
      }
      const commit = prepare(ledger, "INSERT OR REPLACE INTO run_commit_results VALUES (?, ?, ?, ?)");
      const runSubject = prepare(ledger, "INSERT OR REPLACE INTO run_subjects VALUES (?, ?, ?)");
      const receipt = prepare(ledger, "INSERT OR IGNORE INTO command_receipts VALUES (?, ?, ?, ?)");
      for (const fact of added) {
        const payload = fact.payload as { review_command?: { id: string }; git_commit_result?: JsonValue } | null;
        if (fact.kind === "run.created" && fact.payload?.conversation_id && fact.payload.generation !== undefined) runSubject.run(fact.payload.conversation_id, fact.payload.generation, fact.subject.slice(4));
        const command = payload?.review_command;
        if (command?.id) receipt.run(command.id, JSON.stringify(command), fact.seq, fact.subject);
        if (fact.kind === "run.updated" && fact.confidence === "confirmed" && (fact.source === "host-claude" || fact.source === "host-codex") && payload?.git_commit_result) {
          commit.run(fact.fact_id, fact.subject.slice(4), JSON.stringify(payload!.git_commit_result), fact.seq);
        }
      }
      state.last_seq = added.at(-1)?.seq ?? 0;
      if (sinceSeq === undefined) state.generation += 1;
      prepare(ledger, "UPDATE projection_state SET generation = ?, last_seq = ? WHERE id = 1")
        .run(state.generation, state.last_seq);
    }
    refreshSearch(ledger, sinceSeq === undefined ? undefined : added, sinceSeq === undefined ? added : undefined);
    for (const index of indexes) ledger.exec(String(index.sql));
    ledger.exec("COMMIT");
    return state;
  } catch (error) {
    ledger.exec("ROLLBACK");
    forgetRunnerProjection(ledger);
    throw error;
  }
}

/** 台帳の SQLite 接続を受け取り、全表と世代を同じトランザクションで再構築する。 */
export function rebuild(ledger: DatabaseSync): ProjectionState {
  return updateProjection(ledger);
}

/**
 * sinceSeq は反映済みの位置。再送は許し、未反映の範囲を飛ばす指定は拒む。
 * 訂正と実体間の依存の計算には過去の事実も使い、変更した投影の行だけを書き込む。
 */
export function applyIncremental(ledger: DatabaseSync, sinceSeq: number): ProjectionState {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
    throw new RangeError("sinceSeq は非負の安全な整数で指定してください");
  }
  return updateProjection(ledger, sinceSeq);
}

/** 初回の一括投影も、再構築と同じ表と補助記録へ保存する。 */
export function rebuildInitialProjection(ledger: DatabaseSync): ProjectionState {
  return updateProjection(ledger, undefined, true);
}
