import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event, Span } from "../events.ts";
import { migrate } from "./migrate.ts";

export interface Repo {
  key: string;
  rootPath: string;
  name: string;
}

export interface Session {
  id: string;
  repoKey: string;
  name: string;
  client: string;
  traceId: string;
  startedAt: string;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(db);
    return new Store(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  upsertRepo(repo: Repo): void {
    this.db.prepare(`
      INSERT INTO repos (key, root_path, name) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET root_path = excluded.root_path, name = excluded.name
    `).run(repo.key, repo.rootPath, repo.name);
  }

  insertSession(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(session.id, session.repoKey, session.name, session.client, session.traceId, session.startedAt);
  }

  appendEvent(event: Event): void {
    this.db.prepare(`
      INSERT INTO events
        (id, ts, kind, repo_key, session_id, trace_id, span_id, parent_span_id, trace_state, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.ts, event.kind, event.repo, event.session ?? null,
      event.trace.traceId, event.trace.spanId, event.trace.parentSpanId ?? null,
      event.trace.traceState ?? null, JSON.stringify(event.payload),
    );
  }

  listEvents(repoKey?: string): Event[] {
    const rows = repoKey === undefined
      ? this.db.prepare("SELECT * FROM events ORDER BY ts, id").all()
      : this.db.prepare("SELECT * FROM events WHERE repo_key = ? ORDER BY ts, id").all(repoKey);
    return rows.map((row) => ({
      id: row.id as string,
      ts: row.ts as string,
      kind: row.kind as Event["kind"],
      repo: row.repo_key as string,
      ...(row.session_id === null ? {} : { session: row.session_id as string }),
      trace: {
        traceId: row.trace_id as string,
        spanId: row.span_id as string,
        ...(row.parent_span_id === null ? {} : { parentSpanId: row.parent_span_id as string }),
        ...(row.trace_state === null ? {} : { traceState: row.trace_state as string }),
      },
      payload: JSON.parse(row.payload as string) as Event["payload"],
    }));
  }

  insertSpan(span: Span): void {
    this.db.prepare(`
      INSERT INTO spans
        (trace_id, span_id, parent_span_id, trace_state, name, started_at, ended_at, status, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      span.trace.traceId, span.trace.spanId, span.trace.parentSpanId ?? null,
      span.trace.traceState ?? null, span.name, span.startedAt, span.endedAt ?? null,
      span.status, JSON.stringify(span.attributes),
    );
  }

  endSpan(traceId: string, spanId: string, endedAt: string, status: Span["status"]): void {
    const result = this.db.prepare(`
      UPDATE spans SET ended_at = ?, status = ? WHERE trace_id = ? AND span_id = ?
    `).run(endedAt, status, traceId, spanId);
    if (result.changes === 0) throw new Error("Span not found");
  }
}
