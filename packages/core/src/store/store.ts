import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event, Span } from "../events.ts";
import type { AcceptanceResult, Assignment, Role, TokenUsage } from "../delegate/types.ts";
import type { UsageSample } from "../usage/types.ts";
import { migrate } from "./migrate.ts";
import { ulid } from "../ulid.ts";
import { newSpanId } from "../trace.ts";

const BUSY_TIMEOUT_MS = 5000;
const OPEN_RETRY_MS = 20;

export type TaskState = "planned" | "running" | "verifying" | "reviewing" | "merging" | "waiting_human" | "conflict" | "done" | "failed" | "rejected";
export interface GraphRecord {
  id: string; repoKey: string; sessionId: string; goal: string; fingerprint: string; createdAt: string;
}
export interface TaskRecord {
  graphId: string; id: string; title: string; role: string; dependsOn: string[]; state: TaskState; attempts: number;
}

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
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
      migrate(db);
      return new Store(db);
    } catch (error) {
      db.close();
      // 初回 WAL 切替の競合は busy_timeout を待たずに SQLITE_BUSY を返す場合がある。
      if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, OPEN_RETRY_MS);
    }
  }
}

export class Store {
  readonly db: DatabaseSync;
  private readonly changeListeners = new Set<() => void>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) {
      try { listener(); }
      catch { /* 通知先の障害で保存済みの書き込みを失敗扱いにしない */ }
    }
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
    this.notifyChange();
  }

  updateSessionClient(id: string, client: "claude" | "codex" | "planner"): void {
    const result = this.db.prepare("UPDATE sessions SET client = ? WHERE id = ? AND client != ?").run(client, id, client);
    if (result.changes > 0) this.notifyChange();
  }

  findGraph(repo: string, session: string, fingerprint?: string): GraphRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM graphs WHERE repo_key = ? AND session_id = ?
      ${fingerprint === undefined ? "" : "AND fingerprint = ?"} ORDER BY rowid DESC LIMIT 1`)
      .get(...(fingerprint === undefined ? [repo, session] : [repo, session, fingerprint]));
    return row ? { id: String(row.id), repoKey: String(row.repo_key), sessionId: String(row.session_id),
      goal: String(row.goal), fingerprint: String(row.fingerprint), createdAt: String(row.created_at) } : undefined;
  }

  insertGraph(graph: GraphRecord, tasks: TaskRecord[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO graphs (id, repo_key, session_id, goal, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(graph.id, graph.repoKey, graph.sessionId, graph.goal, graph.fingerprint, graph.createdAt);
      const insert = this.db.prepare("INSERT INTO tasks (graph_id, id, title, role, depends_on, state, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const task of tasks) insert.run(graph.id, task.id, task.title, task.role, JSON.stringify(task.dependsOn), task.state, task.attempts);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.notifyChange();
  }

  listTasks(graphId: string): TaskRecord[] {
    return this.db.prepare("SELECT * FROM tasks WHERE graph_id = ? ORDER BY rowid").all(graphId).map((row) => ({
      graphId, id: String(row.id), title: String(row.title), role: String(row.role),
      dependsOn: JSON.parse(String(row.depends_on)), state: row.state as TaskState, attempts: Number(row.attempts),
    }));
  }

  updateTask(graphId: string, id: string, state: TaskState, attempts?: number): void {
    const result = this.db.prepare("UPDATE tasks SET state = ?, attempts = COALESCE(?, attempts) WHERE graph_id = ? AND id = ?")
      .run(state, attempts ?? null, graphId, id);
    if (!result.changes) throw new Error(`Task not found: ${id}`);
    this.notifyChange();
  }

  appendGraphEvent(graph: GraphRecord, kind: string, payload: Record<string, unknown>): string {
    const id = ulid();
    const session = this.db.prepare("SELECT trace_id FROM sessions WHERE id = ?").get(graph.sessionId);
    if (!session) throw new Error("Session not found");
    this.db.prepare(`INSERT INTO events (id, ts, kind, repo_key, session_id, trace_id, span_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, new Date().toISOString(), `planner.${kind}`,
      graph.repoKey, graph.sessionId, String(session.trace_id), newSpanId(), JSON.stringify({ ...payload, graphId: graph.id }));
    this.notifyChange();
    return id;
  }

  listGraphEvents(graphId: string, kind: string): { id: string; payload: Record<string, unknown> }[] {
    return this.db.prepare("SELECT id, payload FROM events WHERE kind = ? AND json_extract(payload, '$.graphId') = ? ORDER BY rowid")
      .all(`planner.${kind}`, graphId).map((row) => ({ id: String(row.id), payload: JSON.parse(String(row.payload)) }));
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
    this.notifyChange();
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

  updateSpanAttributes(traceId: string, spanId: string, attributes: Partial<Span["attributes"]>): void {
    const row = this.db.prepare("SELECT attributes FROM spans WHERE trace_id = ? AND span_id = ?")
      .get(traceId, spanId);
    if (!row) throw new Error("Span not found");
    this.db.prepare("UPDATE spans SET attributes = ? WHERE trace_id = ? AND span_id = ?")
      .run(JSON.stringify({ ...JSON.parse(row.attributes as string), ...attributes }), traceId, spanId);
  }

  endSpan(traceId: string, spanId: string, endedAt: string, status: Span["status"]): void {
    const result = this.db.prepare(`
      UPDATE spans SET ended_at = ?, status = ? WHERE trace_id = ? AND span_id = ?
    `).run(endedAt, status, traceId, spanId);
    if (result.changes === 0) throw new Error("Span not found");
  }

  insertDelegation(row: { id: string; repoKey: string; sessionId: string; parentId?: string; role: Role; title: string; status: string }): void {
    this.db.prepare(`INSERT INTO delegations (id, repo_key, session_id, parent_id, role, title, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.repoKey, row.sessionId, row.parentId ?? null, row.role, row.title, row.status);
    this.notifyChange();
  }

  finishDelegation(id: string, status: string): void {
    const result = this.db.prepare("UPDATE delegations SET status = ? WHERE id = ?").run(status, id);
    if (result.changes > 0) this.notifyChange();
  }

  insertAssignment(id: string, assignment: Assignment): void {
    this.db.prepare(`INSERT INTO assignments
      (delegation_id, executor, model, family, tier, reason, policy_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, assignment.executor, assignment.model, assignment.family, assignment.tier,
        JSON.stringify(assignment.reason), assignment.policyVersion);
    this.notifyChange();
  }

  insertAcceptance(id: string, acceptance: AcceptanceResult): void {
    this.db.prepare(`INSERT INTO acceptances (delegation_id, passed, results, scope_violations)
      VALUES (?, ?, ?, ?)`)
      .run(id, Number(acceptance.passed), JSON.stringify(acceptance.results), JSON.stringify(acceptance.scopeViolations));
  }

  insertReview(id: string, reviewerId: string, verdict: string, comment: string): void {
    this.db.prepare(`INSERT INTO reviews (delegation_id, reviewer_delegation_id, verdict, comment)
      VALUES (?, ?, ?, ?)`)
      .run(id, reviewerId, verdict, comment);
  }

  insertTokenUsage(id: string, usage: TokenUsage, model: string): void {
    this.db.prepare(`INSERT INTO token_usage (delegation_id, input_tokens, output_tokens, model)
      VALUES (?, ?, ?, ?)`)
      .run(id, usage.inputTokens, usage.outputTokens, model);
  }

  appendUsageSample(sample: UsageSample): void {
    this.db.prepare(`INSERT INTO usage_samples (ts, provider, window, percent, resets_at, model)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sample.ts, sample.provider, sample.window, sample.percent,
        sample.resetsAt ?? null, sample.model ?? null);
  }

  latestUsageSamples(): UsageSample[] {
    const rows = this.db.prepare(`
      SELECT ts, provider, window, percent, resets_at, model FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY provider, model, window ORDER BY ts DESC, rowid DESC
        ) AS position FROM usage_samples
      ) WHERE position = 1 ORDER BY provider, model, window
    `).all();
    return rows.map((row) => ({
      ts: row.ts as string, provider: row.provider as UsageSample["provider"],
      window: row.window as string, percent: row.percent as number,
      ...(row.resets_at === null ? {} : { resetsAt: row.resets_at as string }),
      ...(row.model === null ? {} : { model: row.model as string }),
    }));
  }
}
