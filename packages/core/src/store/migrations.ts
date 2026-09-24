export interface Migration {
  version: number;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE repos (
        key TEXT PRIMARY KEY NOT NULL,
        root_path TEXT NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        repo_key TEXT NOT NULL REFERENCES repos(key),
        name TEXT NOT NULL,
        client TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      CREATE TABLE graphs (
        id TEXT PRIMARY KEY NOT NULL,
        repo_key TEXT NOT NULL REFERENCES repos(key),
        session_id TEXT REFERENCES sessions(id),
        goal TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        graph_id TEXT NOT NULL REFERENCES graphs(id),
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        role TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (graph_id, id)
      );
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY NOT NULL,
        repo_key TEXT NOT NULL REFERENCES repos(key),
        session_id TEXT REFERENCES sessions(id),
        parent_id TEXT REFERENCES delegations(id),
        task_id TEXT,
        role TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        round_trips INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE assignments (
        delegation_id TEXT PRIMARY KEY NOT NULL REFERENCES delegations(id),
        executor TEXT NOT NULL,
        model TEXT NOT NULL,
        family TEXT NOT NULL,
        tier TEXT NOT NULL,
        reason TEXT NOT NULL,
        policy_version TEXT NOT NULL
      );
      CREATE TABLE spans (
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        trace_state TEXT,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'unset')),
        attributes TEXT NOT NULL,
        PRIMARY KEY (trace_id, span_id)
      );
      CREATE TABLE events (
        id TEXT PRIMARY KEY NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        repo_key TEXT NOT NULL REFERENCES repos(key),
        session_id TEXT REFERENCES sessions(id),
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        trace_state TEXT,
        payload TEXT NOT NULL
      );
      CREATE TRIGGER events_reject_update BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TRIGGER events_reject_delete BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      -- REPLACE の暗黙 DELETE も、再帰トリガの設定によらず拒否する。
      CREATE TRIGGER events_reject_replace BEFORE INSERT ON events
      WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
      CREATE TABLE acceptances (
        delegation_id TEXT PRIMARY KEY NOT NULL REFERENCES delegations(id),
        passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
        results TEXT NOT NULL,
        scope_violations TEXT NOT NULL
      );
      CREATE TABLE reviews (
        delegation_id TEXT PRIMARY KEY NOT NULL REFERENCES delegations(id),
        reviewer_delegation_id TEXT NOT NULL REFERENCES delegations(id),
        verdict TEXT NOT NULL,
        comment TEXT NOT NULL
      );
      CREATE TABLE usage_samples (
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        window TEXT NOT NULL,
        percent REAL NOT NULL,
        resets_at TEXT,
        model TEXT
      );
      CREATE TABLE token_usage (
        delegation_id TEXT NOT NULL REFERENCES delegations(id),
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        model TEXT NOT NULL
      );
    `,
  },
];
