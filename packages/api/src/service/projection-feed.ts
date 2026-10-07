import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Fact } from "../../../core/src/ledger/facts.ts";
import { PROJECTION_TABLES, type ProjectionState } from "../../../core/src/ledger/rebuild.ts";
import { projectProjects } from "../../../core/src/ledger/projections/projects.ts";
import { getMessageText } from "../../../core/src/ledger/projections/messages.ts";
import { resolveProjectLocation } from "../../../core/src/ledger/repository.ts";
import { createScreenIdentities, type ScreenIdentities } from './screen-identities.ts';
import type { ObservationProgress } from "./index.ts";

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
const LIST_PAGE_SIZE = 1000;
const EXCERPT_LENGTH = 120;
const DETAIL_PAGE_SIZE = 200;
const NAME_LENGTH = 160;
const SCREEN_CACHE_KIB = 16 * 1024;
const IDENTITY_BATCH_FACTS = 256;
const LIST_TABLES = PROJECTION_TABLES.filter(table => table !== "messages" && table !== "message_memberships");
const LIST_COLUMNS: Record<string, string> = {
  tasks: "id, name, project, state",
  runs: "id, conversation_id, generation, state, started_ts, ended_ts, end_evidence, cause, last_evidence, last_evidence_ts, reason, repository_id, worktree_id, cwd, branch, launch, model, effort",
  artifacts: "id, run_id, version, repository_id, worktree_id, patch_hash, attribution, previous_artifact_id",
  approvals: "id, run_id, conversation_id, state, requested_ts",
  findings: "id, artifact_id, version, file, start_line, end_line, severity, state",
};
function decodeFacts(rows: Record<string, unknown>[]): Fact[] {
  return rows.map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
}

export class ProjectionFeed {
  private db: DatabaseSync;
  private catchUp: () => ProjectionState;
  private state: ProjectionState;
  private history: ProjectionPatch[] = [];
  private floor: number;
  private limit: number;
  private cursor = 0;
  private requiresGeneration: boolean;
  private identities: ScreenIdentities = { conversations: {}, runs: {} };
  private observation?: ObservationProgress;
  private registeredRepositories = new Map<string, string[]>();
  private statements = new Map<string, StatementSync>();
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
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -${SCREEN_CACHE_KIB}`);
    this.catchUp = catchUp;
    this.limit = limit;
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
      this.updateIdentities();
      this.updateProjects();
      this.db.exec("DELETE FROM api_conversation_summaries");
      for (const row of this.prepare("SELECT id FROM conversations").iterate()) this.updateSummary(String(row.id));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
    this.cursor = Number(this.prepare("SELECT coalesce(max(cursor), 0) AS cursor FROM api_projection_changes").get()!.cursor);
    this.prepare("DELETE FROM api_projection_changes WHERE cursor <= ?").run(this.cursor);
    this.floor = this.state.last_seq;
  }
  private updateIdentities(sinceSeq?: number): ScreenIdentities {
    const subset = sinceSeq === undefined ? "" : `AND subject IN (SELECT subject FROM facts WHERE seq > ? AND seq <= ?
      AND (kind LIKE 'conversation.%' OR kind = 'run.created'))`;
    const rows = this.prepare(`SELECT seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes,
        json_patch('{}', json_object('provider', json_extract(payload, '$.provider'), 'native_id', json_extract(payload, '$.native_id'),
          'conversation_id', json_extract(payload, '$.conversation_id'), 'generation', json_extract(payload, '$.generation'))) AS payload
      FROM facts WHERE seq <= ? AND (kind LIKE 'conversation.%' OR kind = 'run.created') ${subset} ORDER BY subject, seq`)
      .iterate(...(sinceSeq === undefined ? [this.state.last_seq] : [this.state.last_seq, sinceSeq, this.state.last_seq]));
    const next: ScreenIdentities = { conversations: {}, runs: {} };
    const facts: Fact[] = [];
    let batch: Record<string, unknown>[] = [];
    function flush(): void {
      const decoded = decodeFacts(batch);
      Object.assign(next.conversations, createScreenIdentities(decoded).conversations);
      facts.push(...decoded.filter(fact => fact.kind === "run.created"));
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
    for (const fact of facts) {
      if (fact.kind === "run.created" && fact.payload?.conversation_id && fact.payload.generation !== undefined) {
        runs.push({ conversation_id: fact.payload.conversation_id, generation: fact.payload.generation, subject_id: fact.subject.slice(4) });
      }
    }
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
    const previous = new Map(this.prepare("SELECT * FROM api_projects").all().map(row => [String(row.id), row]));
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
    const previousReferences = new Map(this.prepare("SELECT * FROM api_project_resolution").all()
      .map(row => [String(row.id), JSON.stringify(row)]));
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
    const count = Number(this.prepare(`SELECT count(*) AS count FROM message_memberships WHERE conversation_id = ? AND active = 1`).get(id)!.count);
    const last = this.prepare(`SELECT m.source_ts, m.body FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
      WHERE mm.conversation_id = ? AND mm.active = 1 ORDER BY julianday(m.source_ts) DESC, m.source_event_id DESC, m.id DESC LIMIT 1`).get(id);
    const excerpt = last?.body ? getMessageText(JSON.parse(String(last.body))).slice(0, EXCERPT_LENGTH) : "";
    this.prepare("INSERT OR REPLACE INTO api_conversation_summaries VALUES (?, ?, ?, ?)").run(id, count, last?.source_ts ?? null, excerpt);
  }
  private readList(table: string, ids?: string[], after = ""): Record<string, unknown>[] {
    const where = ids ? "WHERE t.id IN (SELECT value FROM json_each(?))" : "WHERE t.id > ?";
    const parameter = ids ? JSON.stringify(ids) : after;
    const limit = ids ? "" : `LIMIT ${LIST_PAGE_SIZE}`;
    if (table === "conversations") return this.prepare(`SELECT t.id, t.provider, t.origin, t.type, t.task_id, substr(t.name, 1, ${NAME_LENGTH}) AS name, t.cwd,
      r.project_id AS project, coalesce(r.state, 'unregistered') AS project_state,
      coalesce(s.message_count, 0) AS message_count, s.last_message_ts, coalesce(s.last_message_excerpt, '') AS last_message_excerpt
      FROM conversations t LEFT JOIN tasks task ON task.id = t.task_id
      LEFT JOIN api_project_resolution r ON r.id = coalesce(task.project, t.repository_id,
        (SELECT repository_id FROM runs WHERE (conversation_id = t.id OR conversation_id IN (
          SELECT id FROM api_conversation_ids WHERE canonical_id = t.id)) AND repository_id IS NOT NULL ORDER BY generation DESC LIMIT 1))
      LEFT JOIN api_conversation_summaries s ON s.id = t.id ${where} ORDER BY t.id ${limit}`).all(parameter);
    // 試行は画面が木と 1 行の要約に使う欄だけを配り、受け入れの出力や報告の本文は配らない。
    if (table === "delegations") return this.prepare(`SELECT t.id, t.request_id, t.parent_run_id, t.role, t.title, t.attempt, t.state,
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
    return this.prepare(`SELECT ${LIST_COLUMNS[table] ?? "*"} FROM ${table} t ${where} ORDER BY t.id ${limit}`).all(parameter);
  }
  refresh(): ProjectionPatch | "resync" | undefined {
    const state = this.catchUp();
    this.observation = (state as ProjectionState & { observation?: ObservationProgress }).observation;
    if (state.generation === this.state.generation && state.last_seq === this.state.last_seq) return;
    const previous = this.state;
    this.state = state;
    const changes = this.prepare("SELECT * FROM api_projection_changes WHERE cursor > ? ORDER BY cursor").all(this.cursor);
    this.cursor = Number(changes.at(-1)?.cursor ?? this.cursor);
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
    const identityChanged = !!this.prepare("SELECT 1 FROM facts WHERE seq > ? AND seq <= ? AND (kind LIKE 'conversation.%' OR kind = 'run.created') LIMIT 1").get(previous.last_seq, state.last_seq);
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
    groups.set("conversations", ids);
    if (state.generation !== previous.generation || state.last_seq < previous.last_seq) {
      this.history = []; this.requiresGeneration = true; this.floor = state.last_seq;
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
    this.history.push(patch);
    if (this.history.length > this.limit) this.floor = this.history.shift()!.seq;
    // 配信済みの変更は patch の識別子だけに置き換える。
    this.prepare("DELETE FROM api_projection_changes WHERE cursor <= ?").run(this.cursor);
    return patch;
  }
  replay(seq: number, generation?: number): ProjectionPatch[] | undefined {
    if (this.requiresGeneration && generation === undefined) return;
    if (seq < this.floor || seq > this.state.last_seq || generation !== undefined && generation !== this.state.generation) return;
    return this.history.filter(patch => patch.seq > seq);
  }
  snapshot() {
    const projection = Object.fromEntries(LIST_TABLES.map(table => [table, this.readList(table)]));
    projection.projects = this.prepare("SELECT * FROM api_projects ORDER BY id").all();
    const pages = Object.fromEntries(LIST_TABLES.map(table => [table, {
      total: Number(this.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count),
      next: projection[table].length === LIST_PAGE_SIZE ? projection[table].at(-1)!.id : null,
    }]));
    const references = new Set(Object.values(projection).flatMap(rows => rows.flatMap(row =>
      [row.id, row.conversation_id, row.run_id, row.parent_run_id, row.from_id, row.to_id].filter((id): id is string => typeof id === "string"))));
    const identities = {
      conversations: Object.fromEntries(Object.entries(this.identities.conversations).filter(([id]) => references.has(id))),
      runs: Object.fromEntries(Object.entries(this.identities.runs).filter(([id]) => references.has(id))),
    };
    return { seq: this.state.last_seq, generation: this.state.generation, projection, pages, identities,
      ...(this.observation ? { observation: this.observation } : {}) };
  }
  list(table: string, after = "") {
    if (!(LIST_TABLES as readonly string[]).includes(table)) throw new RangeError("Invalid list table");
    const rows = this.readList(table, undefined, after);
    return { seq: this.state.last_seq, generation: this.state.generation, rows,
      next: rows.length === LIST_PAGE_SIZE ? rows.at(-1)!.id : null };
  }
  conversation(id: string, after = "") {
    id = this.conversationId(id);
    const messages = this.prepare(`SELECT m.*, mm.id AS membership_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
      WHERE mm.conversation_id = ? AND mm.active = 1 AND m.id > ? ORDER BY m.id LIMIT ?`).all(id, after, DETAIL_PAGE_SIZE);
    const memberships = messages.map(row => ({ id: row.membership_id, message_id: row.id, conversation_id: id, active: 1 }));
    return { seq: this.state.last_seq, generation: this.state.generation,
      projection: { messages: messages.map(({ membership_id, ...row }) => row), message_memberships: memberships },
      next: messages.length === DETAIL_PAGE_SIZE ? messages.at(-1)!.id : null };
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
