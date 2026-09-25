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
export type TaskDecision = "approve" | "reject" | "retry";
export interface TaskDecisionRow {
  id: number; graphId: string; taskId: string; action: string; at: string;
}

// 判断を受けられる状態。retry だけは failed も受ける。
export function decisionAllowed(state: TaskState, action: TaskDecision): boolean {
  return state === "waiting_human" || state === "conflict" || (state === "failed" && action === "retry");
}

export interface Repo {
  key: string;
  rootPath: string;
  name: string;
}

export type SessionStatus = "running" | "waiting" | "ended";
export type WaitingReason = "permission" | "question";
// 終了の理由。process_exit は pid の死、idle は pid 無しで 30 分の記録断、explicit は hook や操作での終了。
export type EndedReason = "process_exit" | "idle" | "explicit";
export type RoundKind = "request" | "reinstruct" | "report";

export interface DelegationRound {
  delegationId: string;
  seq: number;
  kind: RoundKind;
  text: string;
  at: string;
}

export interface Session {
  id: string;
  repoKey: string;
  name: string;
  client: string;
  traceId: string;
  startedAt: string;
  status?: SessionStatus;
  endedAt?: string;
  endedReason?: EndedReason;
  pid?: number;
  pidStartedAt?: string;
  waitingReason?: WaitingReason;
  goal?: string;
  model?: string;
  lastSeenAt?: string;
}

export interface SessionRow extends Session {
  status: SessionStatus;
  lastSeenAt: string;
}

export interface TurnRow {
  id: string;
  sessionId: string;
  at: string;
  prompt: string;
  summary?: string;
  reply?: string;
  hidden: boolean;
}

// 委譲が生きているとみなす状態。親セッションの終了で lost にする対象。
const ACTIVE_DELEGATION_STATUSES = ["requested", "planned", "running", "waiting"];
const SESSION_NAME_WIDTH = 3;

function sessionFromRow(row: Record<string, unknown>): SessionRow {
  const optional = (value: unknown): string | undefined => value === null || value === undefined ? undefined : String(value);
  return {
    id: String(row.id), repoKey: String(row.repo_key), name: String(row.name), client: String(row.client),
    traceId: String(row.trace_id), startedAt: String(row.started_at), status: String(row.status) as SessionStatus,
    lastSeenAt: String(row.last_seen_at ?? row.started_at),
    ...(row.ended_at === null ? {} : { endedAt: String(row.ended_at) }),
    ...(optional(row.ended_reason) === undefined ? {} : { endedReason: String(row.ended_reason) as EndedReason }),
    ...(row.pid === null ? {} : { pid: Number(row.pid) }),
    ...(row.pid_started_at === null ? {} : { pidStartedAt: String(row.pid_started_at) }),
    ...(row.waiting_reason === null ? {} : { waitingReason: String(row.waiting_reason) as WaitingReason }),
    ...(optional(row.goal) === undefined ? {} : { goal: String(row.goal) }),
    ...(optional(row.model) === undefined ? {} : { model: String(row.model) }),
  };
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
      INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status, ended_at, ended_reason, pid, pid_started_at,
        waiting_reason, goal, model, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.repoKey, session.name, session.client, session.traceId, session.startedAt,
      session.status ?? "running", session.endedAt ?? null, session.endedReason ?? null, session.pid ?? null, session.pidStartedAt ?? null,
      session.waitingReason ?? null, session.goal ?? null, session.model ?? null, session.lastSeenAt ?? session.startedAt);
    this.notifyChange();
  }

  // リポジトリごとの連番で <repo名>-NNN を振る。既存の最大番号の次を使う。
  nextSessionName(repoKey: string): string {
    const repo = this.db.prepare("SELECT name FROM repos WHERE key = ?").get(repoKey);
    if (!repo) throw new Error(`Repository not found: ${repoKey}`);
    const prefix = `${String(repo.name)}-`;
    let max = 0;
    for (const row of this.db.prepare("SELECT name FROM sessions WHERE repo_key = ?").all(repoKey)) {
      const name = String(row.name);
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      max = Math.max(max, Number(suffix));
    }
    return `${prefix}${String(max + 1).padStart(SESSION_NAME_WIDTH, "0")}`;
  }

  // 初回の登録で名前を振る。採番と挿入を 1 つのトランザクションで行い、並行登録で番号を重ねない。
  insertNamedSession(session: Omit<Session, "name">): string {
    this.db.exec("BEGIN IMMEDIATE");
    let name: string;
    try {
      name = this.nextSessionName(session.repoKey);
      this.db.prepare(`
        INSERT INTO sessions (id, repo_key, name, client, trace_id, started_at, status, pid, pid_started_at, goal, model, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, session.repoKey, name, session.client, session.traceId, session.startedAt,
        session.status ?? "running", session.pid ?? null, session.pidStartedAt ?? null,
        session.goal ?? null, session.model ?? null, session.lastSeenAt ?? session.startedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.notifyChange();
    return name;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? sessionFromRow(row as Record<string, unknown>) : undefined;
  }

  // 生死を確かめる対象。running か waiting のセッション。
  listLiveSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status IN ('running', 'waiting') ORDER BY started_at, id").all()
      .map((row) => sessionFromRow(row as Record<string, unknown>));
  }

  updateSessionClient(id: string, client: "claude" | "codex" | "planner"): void {
    const result = this.db.prepare("UPDATE sessions SET client = ? WHERE id = ? AND client != ?").run(client, id, client);
    if (result.changes > 0) this.notifyChange();
  }

  // 生死判定の材料。pid と起動時刻を記録し、last_seen_at を進める。
  setSessionProcess(id: string, pid: number, pidStartedAt: string | undefined, seenAt: string): void {
    const result = this.db.prepare(`UPDATE sessions SET pid = ?, pid_started_at = ?, last_seen_at = ?
      WHERE id = ? AND status != 'ended'`).run(pid, pidStartedAt ?? null, seenAt, id);
    if (result.changes > 0) this.notifyChange();
  }

  // 同じ id の再登録。終了済みなら running に戻す。名前は変えず、lost にした委譲も戻さない。
  resumeSession(id: string, seenAt: string): boolean {
    const result = this.db.prepare(`UPDATE sessions SET status = 'running', ended_at = NULL, ended_reason = NULL,
      waiting_reason = NULL, last_seen_at = ? WHERE id = ? AND status = 'ended'`).run(seenAt, id);
    if (result.changes > 0) this.notifyChange();
    return result.changes > 0;
  }

  // pid を持たないまま 30 分の規則で ended にしたセッションだけを、観測で running に戻す。
  // pid の死で ended にしたものは戻さない。戻すのは再登録か根の hello だけ。
  reviveIdleSession(id: string, seenAt: string): boolean {
    const result = this.db.prepare(`UPDATE sessions SET status = 'running', ended_at = NULL, ended_reason = NULL,
      waiting_reason = NULL, last_seen_at = ? WHERE id = ? AND status = 'ended' AND ended_reason = 'idle'`).run(seenAt, id);
    if (result.changes > 0) this.notifyChange();
    return result.changes > 0;
  }

  setSessionModel(id: string, model: string): void {
    const result = this.db.prepare("UPDATE sessions SET model = ? WHERE id = ? AND model IS NOT ?").run(model, id, model);
    if (result.changes > 0) this.notifyChange();
  }

  // 最初の指示を goal にする。以降は変えない。
  setSessionGoalIfEmpty(id: string, goal: string): void {
    const result = this.db.prepare("UPDATE sessions SET goal = ? WHERE id = ? AND goal IS NULL").run(goal, id);
    if (result.changes > 0) this.notifyChange();
  }

  // 観測があった。待ちなら running に戻し、last_seen_at を進める。
  touchSession(id: string, seenAt: string): void {
    const result = this.db.prepare(`UPDATE sessions SET last_seen_at = ?, status = 'running', waiting_reason = NULL
      WHERE id = ? AND status != 'ended'`).run(seenAt, id);
    if (result.changes > 0) this.notifyChange();
  }

  setSessionWaiting(id: string, reason: WaitingReason, seenAt: string): void {
    const result = this.db.prepare(`UPDATE sessions SET status = 'waiting', waiting_reason = ?, last_seen_at = ?
      WHERE id = ? AND status != 'ended'`).run(reason, seenAt, id);
    if (result.changes > 0) this.notifyChange();
  }

  // 終了。走っていた委譲は親を失うので lost にし、delegation.lost を追記する。すでに終わっていれば何もしない。
  // lost の委譲があとで実際に完了したときは finishDelegation が done や failed で上書きする。事実を優先する。
  endSession(id: string, endedAt: string, reason: EndedReason = "explicit"): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    let changed: number;
    try {
      const session = this.db.prepare("SELECT repo_key, trace_id, status FROM sessions WHERE id = ?").get(id);
      changed = session && session.status !== "ended"
        ? Number(this.db.prepare(`UPDATE sessions SET status = 'ended', ended_at = ?, ended_reason = ?, waiting_reason = NULL
          WHERE id = ?`).run(endedAt, reason, id).changes)
        : 0;
      if (changed > 0) {
        const placeholders = ACTIVE_DELEGATION_STATUSES.map(() => "?").join(", ");
        const lost = this.db.prepare(`SELECT id FROM delegations WHERE session_id = ? AND status IN (${placeholders})`)
          .all(id, ...ACTIVE_DELEGATION_STATUSES).map((row) => String(row.id));
        this.db.prepare(`UPDATE delegations SET status = 'lost' WHERE session_id = ? AND status IN (${placeholders})`)
          .run(id, ...ACTIVE_DELEGATION_STATUSES);
        for (const delegationId of lost) {
          this.appendEvent({ id: ulid(), ts: endedAt, kind: "delegation.lost", repo: String(session!.repo_key), session: id,
            trace: { traceId: String(session!.trace_id), spanId: newSpanId() },
            payload: { delegationId, reason: "親セッションの終了で失われた" } }, { notify: false });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (changed > 0) this.notifyChange();
    return changed > 0;
  }

  insertTurn(turn: { id: string; sessionId: string; at: string; prompt: string; summary?: string; reply?: string }): void {
    this.db.prepare("INSERT INTO turns (id, session_id, at, prompt, summary, reply) VALUES (?, ?, ?, ?, ?, ?)")
      .run(turn.id, turn.sessionId, turn.at, turn.prompt, turn.summary ?? null, turn.reply ?? null);
    this.notifyChange();
  }

  // 応答を未完の直近の turn に付ける。無ければ空の prompt で turn を作る。
  finishTurn(sessionId: string, at: string, summary: string, reply: string, newId: () => string): string {
    const open = this.db.prepare(`SELECT id FROM turns WHERE session_id = ? AND summary IS NULL
      ORDER BY at DESC, rowid DESC LIMIT 1`).get(sessionId);
    if (open) {
      this.db.prepare("UPDATE turns SET summary = ?, reply = ? WHERE id = ?").run(summary, reply, String(open.id));
      this.notifyChange();
      return String(open.id);
    }
    const id = newId();
    this.insertTurn({ id, sessionId, at, prompt: "", summary, reply });
    return id;
  }

  setTurnHidden(id: string, hidden: boolean): void {
    const result = this.db.prepare("UPDATE turns SET hidden = ? WHERE id = ?").run(Number(hidden), id);
    if (result.changes > 0) this.notifyChange();
  }

  listTurns(sessionId: string, limit?: number): TurnRow[] {
    const rows = limit === undefined
      ? this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY at, rowid").all(sessionId)
      : this.db.prepare(`SELECT * FROM (SELECT *, rowid AS position FROM turns WHERE session_id = ?
        ORDER BY at DESC, rowid DESC LIMIT ?) ORDER BY at, position`).all(sessionId, limit);
    return rows.map((row) => ({
      id: String(row.id), sessionId: String(row.session_id), at: String(row.at), prompt: String(row.prompt),
      ...(row.summary === null ? {} : { summary: String(row.summary) }),
      ...(row.reply === null ? {} : { reply: String(row.reply) }),
      hidden: Number(row.hidden) === 1,
    }));
  }

  insertTaskDecision(graphId: string, taskId: string, action: string, at: string): void {
    this.db.prepare("INSERT INTO task_decisions (graph_id, task_id, action, at) VALUES (?, ?, ?, ?)").run(graphId, taskId, action, at);
    this.notifyChange();
  }

  // 記録順。id は rowid で、planner が適用済みの印に使う。
  listTaskDecisions(graphId: string): TaskDecisionRow[] {
    return this.db.prepare("SELECT rowid AS id, task_id, action, at FROM task_decisions WHERE graph_id = ? ORDER BY rowid").all(graphId)
      .map((row) => ({ id: Number(row.id), graphId, taskId: String(row.task_id), action: String(row.action), at: String(row.at) }));
  }

  getGraph(id: string): GraphRecord | undefined {
    const row = this.db.prepare("SELECT * FROM graphs WHERE id = ?").get(id);
    return row ? { id: String(row.id), repoKey: String(row.repo_key), sessionId: String(row.session_id),
      goal: String(row.goal), fingerprint: String(row.fingerprint), createdAt: String(row.created_at) } : undefined;
  }

  getTask(graphId: string, id: string): TaskRecord | undefined {
    return this.listTasks(graphId).find((task) => task.id === id);
  }

  getTurn(id: string): TurnRow | undefined {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? {
      id: String(row.id), sessionId: String(row.session_id), at: String(row.at), prompt: String(row.prompt),
      ...(row.summary === null ? {} : { summary: String(row.summary) }),
      ...(row.reply === null ? {} : { reply: String(row.reply) }),
      hidden: Number(row.hidden) === 1,
    } : undefined;
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

  // notify を false にするのは、呼び出し側がトランザクションの COMMIT 後にまとめて通知するとき。
  appendEvent(event: Event, options: { notify?: boolean } = {}): void {
    this.db.prepare(`
      INSERT INTO events
        (id, ts, kind, repo_key, session_id, trace_id, span_id, parent_span_id, trace_state, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.ts, event.kind, event.repo, event.session ?? null,
      event.trace.traceId, event.trace.spanId, event.trace.parentSpanId ?? null,
      event.trace.traceState ?? null, JSON.stringify(event.payload),
    );
    if (options.notify !== false) this.notifyChange();
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

  // task は依頼文、scope と outputs は依頼の指定、worktree は子が働いた作業木。詳細パネルに出す。
  insertDelegation(row: { id: string; repoKey: string; sessionId: string; parentId?: string; role: Role; title: string;
    status: string; kind?: "delegation" | "subagent"; task?: string; scope?: string[]; outputs?: string[]; worktree?: string }): void {
    this.db.prepare(`INSERT INTO delegations (id, repo_key, session_id, parent_id, role, title, status, kind, task, scope, outputs, worktree)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.repoKey, row.sessionId, row.parentId ?? null, row.role, row.title, row.status, row.kind ?? "delegation",
        row.task ?? null, row.scope ? JSON.stringify(row.scope) : null, row.outputs ? JSON.stringify(row.outputs) : null,
        row.worktree ?? null);
    this.notifyChange();
  }

  // output は子の最終の出力。省略すれば既存の値を保つ。
  finishDelegation(id: string, status: string, output?: string): void {
    const result = this.db.prepare("UPDATE delegations SET status = ?, output = COALESCE(?, output) WHERE id = ?")
      .run(status, output ?? null, id);
    if (result.changes > 0) this.notifyChange();
  }

  // 往復の記録。seq は委譲ごとの連番で、採番と挿入を 1 つのトランザクションで行う。
  insertDelegationRound(delegationId: string, kind: RoundKind, text: string, at: string): number {
    this.db.exec("BEGIN IMMEDIATE");
    let seq: number;
    try {
      seq = Number(this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM delegation_rounds WHERE delegation_id = ?")
        .get(delegationId)!.seq);
      this.db.prepare("INSERT INTO delegation_rounds (delegation_id, seq, kind, text, at) VALUES (?, ?, ?, ?, ?)")
        .run(delegationId, seq, kind, text, at);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.notifyChange();
    return seq;
  }

  listDelegationRounds(delegationId: string): DelegationRound[] {
    return this.db.prepare("SELECT * FROM delegation_rounds WHERE delegation_id = ? ORDER BY seq").all(delegationId)
      .map((row) => ({ delegationId: String(row.delegation_id), seq: Number(row.seq), kind: String(row.kind) as RoundKind,
        text: String(row.text), at: String(row.at) }));
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
