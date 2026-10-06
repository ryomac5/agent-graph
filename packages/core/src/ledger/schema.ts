import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;
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

function migrateToVersion1(db: DatabaseSync): void {
  db.exec(FACTS_DDL);
  db.exec(PROJECTION_DDL);
}
const MIGRATIONS = [migrateToVersion1] as const;

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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
