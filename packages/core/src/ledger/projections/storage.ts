import type { DatabaseSync } from "node:sqlite";

// 版を上げると、次の反映で全投影を台帳から作り直す。3 で会話と委譲のプロジェクトと状態の規則を変えた。
export const RUNNER_PROJECTION_VERSION = 3;
export const RECORD_ENTITIES = ["run", "conversation", "delegation", "artifact", "approval", "finding", "relation", "message", "message_membership"] as const;

const PROJECTION_VERSION_DDL = "CREATE TABLE IF NOT EXISTS runner_projection_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)";
export const PROJECTION_STORAGE_DDL = `${PROJECTION_VERSION_DDL};
CREATE TABLE IF NOT EXISTS projection_records (projection TEXT NOT NULL, entity_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projection, entity_id)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS entity_records (
    entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, last_seq INTEGER NOT NULL,
    conversation_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.conversation_id')) VIRTUAL,
    run_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.run_id')) VIRTUAL,
    task_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.task_id')) VIRTUAL,
    worktree_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.worktree_id')) VIRTUAL,
    native_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.native_id')) VIRTUAL,
    provider TEXT GENERATED ALWAYS AS (json_extract(data, '$.provider')) VIRTUAL,
    state TEXT GENERATED ALWAYS AS (json_extract(data, '$.state')) VIRTUAL,
    PRIMARY KEY (entity, id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS entity_conversation ON entity_records(entity, conversation_id);
  CREATE INDEX IF NOT EXISTS entity_run ON entity_records(entity, run_id);
  CREATE INDEX IF NOT EXISTS entity_task ON entity_records(entity, task_id);
  CREATE INDEX IF NOT EXISTS entity_worktree ON entity_records(entity, worktree_id);
  CREATE INDEX IF NOT EXISTS entity_native ON entity_records(entity, provider, native_id);
  CREATE INDEX IF NOT EXISTS entity_state ON entity_records(entity, state);
  CREATE INDEX IF NOT EXISTS facts_timestamp ON facts(julianday(source_ts));
  CREATE INDEX IF NOT EXISTS runs_state ON runs(state, conversation_id);
  CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id, generation);
  CREATE INDEX IF NOT EXISTS artifacts_run_version ON artifacts(run_id, version);
  CREATE INDEX IF NOT EXISTS artifacts_successor ON artifacts(previous_artifact_id);
  CREATE INDEX IF NOT EXISTS findings_artifact ON findings(artifact_id, state);
  CREATE INDEX IF NOT EXISTS findings_state ON findings(state);
  CREATE INDEX IF NOT EXISTS approvals_run ON approvals(run_id, state);
  CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state);
  CREATE INDEX IF NOT EXISTS delegations_state ON delegations(state);
  CREATE INDEX IF NOT EXISTS relations_source ON relations(from_id, type, active);
  CREATE INDEX IF NOT EXISTS membership_conversation ON message_memberships(conversation_id, active, message_id);
  CREATE INDEX IF NOT EXISTS conversations_native ON conversations(provider, native_id);
  CREATE TABLE IF NOT EXISTS run_subjects (conversation_id TEXT NOT NULL, generation INTEGER NOT NULL, subject_id TEXT NOT NULL, PRIMARY KEY(conversation_id, generation)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS command_receipts (id TEXT PRIMARY KEY, data TEXT NOT NULL, seq INTEGER NOT NULL, subject TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS run_commit_results (fact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL, seq INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS run_commit_result_run ON run_commit_results(run_id);
  CREATE TABLE IF NOT EXISTS delegation_runs (run_id TEXT NOT NULL, delegation_id TEXT NOT NULL, PRIMARY KEY(run_id, delegation_id)) WITHOUT ROWID;`;

// 定義から一覧を導き、補助表の追加も一括投影の照合対象に含める。
export const PROJECTION_STORAGE_TABLES = [...PROJECTION_STORAGE_DDL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)]
  .map((match) => match[1]);
export const PROJECTION_STORAGE_INDEXES = [...PROJECTION_STORAGE_DDL.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)]
  .map((match) => match[1]);

export function createProjectionStorage(db: DatabaseSync): void {
  // 旧版の文字列時刻の索引だけを移行し、作成済みの式索引は再構築しない。
  if (db.prepare("PRAGMA index_info(facts_timestamp)").all().some((column) => column.name === "source_ts")) {
    db.exec("DROP INDEX facts_timestamp");
  }
  db.exec(PROJECTION_STORAGE_DDL);
}

const INITIALIZED = new WeakSet<DatabaseSync>();

/** 追加の投影の版を独立して持ち、古い表は台帳から再構築する。 */
export function initializeRunnerProjection(db: DatabaseSync): boolean {
  if (INITIALIZED.has(db)) return false;
  db.exec(PROJECTION_VERSION_DDL);
  const version = Number(db.prepare("SELECT version FROM runner_projection_version WHERE id = 1").get()?.version ?? 0);
  if (version === RUNNER_PROJECTION_VERSION) { INITIALIZED.add(db); return false; }
  createProjectionStorage(db);
  db.prepare("INSERT OR REPLACE INTO runner_projection_version VALUES (1, ?)").run(RUNNER_PROJECTION_VERSION);
  INITIALIZED.add(db);
  return true;
}

export function forgetRunnerProjection(db: DatabaseSync): void { INITIALIZED.delete(db); }
