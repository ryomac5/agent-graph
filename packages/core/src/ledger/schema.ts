import type { DatabaseSync } from "node:sqlite";
import { createProjectionStorage, PROJECTION_STORAGE_TABLES, PROJECTION_STORAGE_INDEXES } from "./projections/storage.ts";
import { projectConversations, encodeNameOrder, extractMessageName } from "./projections/conversations.ts";
import { projectMessages } from "./projections/messages.ts";
import { projectRuns } from "./projections/runs.ts";
import { projectApprovals } from "./projections/approvals.ts";
import { serializeValue } from "./projections/relations.ts";
import type { Fact, JsonValue } from "./facts.ts";
import { collectProjectionDependencies } from "./projections/dependencies.ts";
import { initializeSearch, refreshSearch } from "./search.ts";

export const SCHEMA_VERSION = 5;
export const FACT_SCHEMA_VERSION = 1;
export const FACTS_DDL = `CREATE TABLE facts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT,
  payload_hash TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  observed_ts TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  cursor TEXT,
  confidence TEXT NOT NULL,
  supersedes TEXT,
  UNIQUE (source, source_event_id)
);`;

// 投影は捨てて再構築できる。台帳も実体間も外部キーでは縛らない。
export const PROJECTION_DDL = `
CREATE TABLE projection_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO projection_state (id) VALUES (1);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, name TEXT, purpose TEXT, project TEXT, state TEXT
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, provider TEXT, native_id TEXT, origin TEXT, type TEXT,
  history_format TEXT, task_id TEXT
);
CREATE TABLE relations (
  id TEXT PRIMARY KEY, type TEXT, from_id TEXT, to_id TEXT, evidence TEXT,
  confidence TEXT, active INTEGER
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, conversation_id TEXT, generation INTEGER, state TEXT,
  started_ts TEXT, ended_ts TEXT, end_evidence TEXT, cause TEXT, last_evidence TEXT,
  last_evidence_ts TEXT, reason TEXT, base_sha TEXT, pid INTEGER,
  start_fingerprint TEXT, repository_id TEXT, worktree_id TEXT
);
CREATE TABLE connections (
  id TEXT PRIMARY KEY, run_id TEXT, type TEXT, fingerprint TEXT, state TEXT,
  last_evidence TEXT, last_evidence_ts TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, provider TEXT, native_id TEXT, version INTEGER, role TEXT,
  phase TEXT, body TEXT, body_state TEXT, tool_output TEXT
);
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, request_id TEXT, parent_run_id TEXT, origin TEXT, role TEXT,
  title TEXT, task TEXT, accept TEXT, scope TEXT, cwd TEXT, constraints TEXT,
  attempt INTEGER, state TEXT, result TEXT, attempts TEXT
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, run_id TEXT, version INTEGER, repository_id TEXT,
  worktree_id TEXT, base_sha TEXT, head_sha TEXT, patch_hash TEXT, untracked TEXT,
  verification TEXT, commits TEXT, attribution TEXT, previous_artifact_id TEXT, diff TEXT
);
CREATE TABLE aliases (
  id TEXT PRIMARY KEY, entity_id TEXT, kind TEXT, name TEXT
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, run_id TEXT, connection_id TEXT, conversation_id TEXT,
  request_id TEXT, state TEXT, available_decisions TEXT, decision TEXT, request TEXT,
  reason TEXT, artifact_id TEXT, patch_hash TEXT
);
CREATE TABLE findings (
  id TEXT PRIMARY KEY, artifact_id TEXT, version INTEGER, file TEXT,
  start_line INTEGER, end_line INTEGER, side TEXT, context_hash TEXT, body TEXT,
  severity TEXT, state TEXT
);
CREATE TABLE message_memberships (
  id TEXT PRIMARY KEY, message_id TEXT, conversation_id TEXT, active INTEGER
);
`;

const NAME_PROJECTION_DDL = `CREATE TABLE message_name_inputs (
      id TEXT PRIMARY KEY, source_time REAL NOT NULL, source_event_id TEXT NOT NULL, name TEXT NOT NULL, message_order TEXT NOT NULL
    );
    CREATE TABLE conversation_name_candidates (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      source_time REAL NOT NULL, source_event_id TEXT NOT NULL, name TEXT NOT NULL, message_order TEXT NOT NULL
    );
    CREATE INDEX conversation_name_first ON conversation_name_candidates
      (conversation_id, source_time, source_event_id, message_order);
    CREATE INDEX membership_message ON message_memberships (message_id);`;

export const PROJECTION_SCHEMA_TABLES = [
  ...[...PROJECTION_DDL.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]),
  ...[...NAME_PROJECTION_DDL.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]),
  ...PROJECTION_STORAGE_TABLES,
];
export const PROJECTION_SCHEMA_INDEXES = [
  ...[...NAME_PROJECTION_DDL.matchAll(/CREATE INDEX (\w+)/g)].map((match) => match[1]),
  ...PROJECTION_STORAGE_INDEXES,
];

function migrateToVersion1(db: DatabaseSync): void {
  db.exec(FACTS_DDL);
  db.exec(PROJECTION_DDL);
}
function migrateToVersion2(db: DatabaseSync): void {
  db.exec(`CREATE INDEX facts_subject_seq ON facts (subject, seq);
    CREATE TABLE fact_projection_dependencies (
      projection TEXT NOT NULL, subject TEXT NOT NULL, direction TEXT NOT NULL,
      key TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (projection, subject, direction, key, seq)
    ) WITHOUT ROWID;
    CREATE INDEX fact_projection_dependency_lookup
      ON fact_projection_dependencies (projection, direction, key, subject, seq);`);
  const insertDependency = db.prepare("INSERT OR IGNORE INTO fact_projection_dependencies VALUES (?, ?, ?, ?, ?)");
  for (const row of db.prepare("SELECT * FROM facts ORDER BY seq").iterate()) {
    const fact = { ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact;
    for (const dependency of collectProjectionDependencies(fact)) {
      insertDependency.run(dependency.projection, fact.subject, dependency.direction, dependency.key, fact.seq);
    }
  }
  db.exec(`ALTER TABLE conversations ADD COLUMN name TEXT;
    ALTER TABLE conversations ADD COLUMN name_is_provisional INTEGER NOT NULL DEFAULT 0;`);
  db.exec(NAME_PROJECTION_DDL);
  const lastSeq = Number(db.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq);
  const facts = db.prepare("SELECT * FROM facts WHERE seq <= ?").all(lastSeq).map((row) => ({
    ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)),
  } as Fact));
  const update = db.prepare("UPDATE conversations SET name = ?, name_is_provisional = ? WHERE id = ?");
  for (const conversation of projectConversations(facts).conversations) {
    update.run(conversation.name, Number(conversation.name_is_provisional), conversation.id);
  }
  const insert = db.prepare("INSERT INTO message_name_inputs VALUES (?, ?, ?, ?, ?)");
  for (const message of projectMessages(facts).messages) {
    insert.run(message.id, Date.parse(message.source_ts), encodeNameOrder(message.source_event_id),
      extractMessageName(message), encodeNameOrder(message.id));
  }
  db.exec(`INSERT INTO conversation_name_candidates
    SELECT m.id, m.conversation_id, m.message_id, n.source_time, n.source_event_id, n.name, n.message_order
    FROM message_memberships m JOIN message_name_inputs n ON n.id = m.message_id
    WHERE m.active = 1 AND m.conversation_id IS NOT NULL AND n.name <> '';`);
}
// 画面が読む発言の時刻と出所、実行の起動設定と作業ツリー、承認の要求時刻を列に足す。
function migrateToVersion3(db: DatabaseSync): void {
  db.exec(`ALTER TABLE messages ADD COLUMN source_ts TEXT;
    ALTER TABLE messages ADD COLUMN source_event_id TEXT;
    ALTER TABLE messages ADD COLUMN source TEXT;
    ALTER TABLE messages ADD COLUMN confidence TEXT;
    ALTER TABLE runs ADD COLUMN launch TEXT;
    ALTER TABLE runs ADD COLUMN cwd TEXT;
    ALTER TABLE runs ADD COLUMN branch TEXT;
    ALTER TABLE approvals ADD COLUMN requested_ts TEXT;`);
  const lastSeq = Number(db.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq);
  const facts = db.prepare("SELECT * FROM facts WHERE seq <= ?").all(lastSeq).map((row) => ({
    ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)),
  } as Fact));
  const message = db.prepare("UPDATE messages SET source_ts = ?, source_event_id = ?, source = ?, confidence = ? WHERE id = ?");
  for (const row of projectMessages(facts).messages) {
    message.run(row.source_ts, row.source_event_id, row.source, row.confidence, row.id);
  }
  const run = db.prepare("UPDATE runs SET launch = ?, cwd = ?, branch = ? WHERE id = ?");
  for (const row of projectRuns(facts)) {
    run.run(row.launch === undefined ? null : serializeValue(row.launch), row.cwd ?? null, row.branch ?? null, row.id);
  }
  const approval = db.prepare("UPDATE approvals SET requested_ts = ? WHERE id = ?");
  for (const row of projectApprovals(facts)) approval.run(row.requested_ts ?? null, row.id);
}
function migrateToVersion4(db: DatabaseSync): void { initializeSearch(db); refreshSearch(db); }
// 会話に依頼の抜粋の列を足し、名前の規則の変更を既存の発言に当て直す。発言の全体は再投影しない。
function migrateToVersion5(db: DatabaseSync): void {
  db.exec("ALTER TABLE conversations ADD COLUMN first_request_excerpt TEXT");
  db.exec("DELETE FROM message_name_inputs; DELETE FROM conversation_name_candidates");
  const insert = db.prepare("INSERT INTO message_name_inputs VALUES (?, ?, ?, ?, ?)");
  for (const row of db.prepare("SELECT id, role, body, source_ts, source_event_id FROM messages").iterate()) {
    const body = row.body === null ? undefined : JSON.parse(String(row.body)) as JsonValue;
    insert.run(String(row.id), Date.parse(String(row.source_ts)), encodeNameOrder(String(row.source_event_id)),
      extractMessageName({ role: row.role === null ? null : String(row.role), body }), encodeNameOrder(String(row.id)));
  }
  db.exec(`INSERT INTO conversation_name_candidates
    SELECT m.id, m.conversation_id, m.message_id, n.source_time, n.source_event_id, n.name, n.message_order
    FROM message_memberships m JOIN message_name_inputs n ON n.id = m.message_id
    WHERE m.active = 1 AND m.conversation_id IS NOT NULL AND n.name <> '';`);
  const lastSeq = Number(db.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq);
  // 会話の名前は作業と会話の事実だけで決まる。発言の事実は名前の候補の索引から読む。
  const facts = db.prepare("SELECT * FROM facts WHERE seq <= ? AND (kind LIKE 'task.%' OR kind LIKE 'conversation.%')")
    .all(lastSeq).map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
  const first = db.prepare(`SELECT name FROM conversation_name_candidates
    WHERE conversation_id = ? ORDER BY source_time, source_event_id, message_order LIMIT 1`);
  const ids = db.prepare("SELECT id FROM conversations").all().map((row) => String(row.id));
  const names = new Map<string, string>();
  for (const id of ids) {
    const row = first.get(id);
    if (row) names.set(id, String(row.name));
  }
  const records = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_records'").get()
    ? db.prepare("UPDATE projection_records SET data = ? WHERE projection = 'conversations' AND entity_id = ?") : undefined;
  const update = db.prepare("UPDATE conversations SET name = ?, name_is_provisional = ?, first_request_excerpt = ? WHERE id = ?");
  for (const conversation of projectConversations(facts, names).conversations) {
    update.run(conversation.name, Number(conversation.name_is_provisional), conversation.first_request_excerpt, conversation.id);
    records?.run(JSON.stringify(conversation), conversation.id);
  }
}
const MIGRATIONS = [migrateToVersion1, migrateToVersion2, migrateToVersion3, migrateToVersion4, migrateToVersion5] as const;

export function initializeSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    if (!hasVersion) {
      const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
      if (existing) throw new Error("台帳ではない既存のデータベースは開けません");
      db.exec("CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
      db.exec("INSERT INTO schema_version (id, version) VALUES (1, 0)");
    }
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get();
    const version = row?.version;
    if (typeof version !== "number" || version < 0 || version > SCHEMA_VERSION) {
      throw new Error("台帳の schema_version は未対応です");
    }
    for (let index = version; index < SCHEMA_VERSION; index += 1) {
      MIGRATIONS[index](db);
      db.prepare("UPDATE schema_version SET version = ? WHERE id = 1").run(index + 1);
    }
    initializeSearch(db);
    createProjectionStorage(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
