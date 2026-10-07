import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { Fact, JsonValue } from './facts.ts';
import { projectArtifacts } from './projections/artifacts.ts';
import { projectConversations } from './projections/conversations.ts';
import { getMessageText, projectMessages } from './projections/messages.ts';
import { projectRuns } from './projections/runs.ts';
import { createNativeId, projectConversationIds } from './projections/relations.ts';
import { prepareProjectionFacts } from './projections/delegations.ts';

export const SEARCH_KINDS = ['message', 'tool_output', 'diff', 'finding', 'task', 'alias'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
export type SearchMode = 'fts5' | 'substring';
export class SearchValidationError extends TypeError {}
export interface SearchQuery {
  query: string; project?: string; provider?: string; from?: string; to?: string;
  kind?: SearchKind; limit?: number; offset?: number;
}
export interface SearchResult {
  id: string; fact_id: string; subject: string; kind: SearchKind; body: string | null;
  reason: string | null; conversation_id: string | null; run_id: string | null;
  message_id: string | null; project: string | null; provider: string | null;
  source_ts: string; confidence: string;
}
export interface SearchResponse {
  mode: SearchMode; results: SearchResult[]; total: number;
  unsupported: { subject: string; reason: string }[];
}
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TRIGRAM_MIN_LENGTH = 3;
const MAX_UNSUPPORTED_NOTICES = 100;
type StoredRow = Record<string, unknown>;
const STATEMENTS = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function prepare(db: DatabaseSync, sql: string): StatementSync {
  let statements = STATEMENTS.get(db);
  if (!statements) { statements = new Map(); STATEMENTS.set(db, statements); }
  let statement = statements.get(sql);
  if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
  return statement;
}
const METADATA_FIELDS = ['provider', 'native_id', 'conversation_id', 'task_id', 'run_id',
  'repository_id', 'message_id', 'entity_id', 'artifact_id', 'version', 'role', 'active',
  'history_format', 'origin', 'type', 'generation', 'project'];
const SEARCH_ENTITIES = new Set(['task', 'conversation', 'run', 'message', 'message_membership', 'artifact', 'finding', 'alias']);
const SOURCE_FILTER = [...SEARCH_ENTITIES].map(entity => `kind LIKE '${entity}.%'`).join(' OR ');

function writeSources(db: DatabaseSync, facts: readonly Fact[]): void {
  const insert = prepare(db, 'INSERT OR IGNORE INTO search_sources VALUES (?, ?)');
  const fresh: Fact[] = [];
  for (const fact of facts) {
    if (!SEARCH_ENTITIES.has(fact.kind.split('.')[0])) continue;
    const payload = (fact.payload ?? {}) as Record<string, JsonValue>;
    const metadata = Object.fromEntries(METADATA_FIELDS.map(field => [field, payload[field] ?? null]));
    metadata.has_tool_output = payload.tool_output !== undefined || Boolean(Array.isArray(payload.body)
      && payload.body.some(block => block && typeof block === 'object' && !Array.isArray(block)
        && ['tool_result', 'tool_output'].includes(String(block.type))));
    if (insert.run(fact.fact_id, JSON.stringify(metadata)).changes) fresh.push(fact);
  }
  // 主キーの順に投入し、初回の大量の参照でページの分割を繰り返さない。
  writeReferences(db, fresh.sort((left, right) => left.fact_id < right.fact_id ? -1 : left.fact_id > right.fact_id ? 1 : 0));
}

// 参照を索引化し、本文を読む前に影響範囲と必要な文脈を求める。
function initializeReferences(db: DatabaseSync): void {
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_references'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS search_references (
    fact_id TEXT NOT NULL, subject TEXT NOT NULL, direction TEXT NOT NULL, key TEXT NOT NULL,
    PRIMARY KEY(fact_id, direction, key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS search_reference_subject ON search_references(subject, direction, key);
  CREATE INDEX IF NOT EXISTS search_reference_key ON search_references(key, direction, subject);
  CREATE INDEX IF NOT EXISTS search_project ON search_documents(project);`);
  db.exec('DROP INDEX IF EXISTS search_conversation; DROP INDEX IF EXISTS search_run; DROP INDEX IF EXISTS search_context_seq;');
  db.exec(`DROP TRIGGER IF EXISTS search_reference_created;
    CREATE TRIGGER IF NOT EXISTS search_reference_deleted AFTER DELETE ON search_sources BEGIN
    DELETE FROM search_references WHERE fact_id = OLD.fact_id; END;`);
  if (!existing) {
    const facts = db.prepare(`SELECT f.fact_id, f.subject, f.kind, s.metadata FROM facts f
      JOIN search_sources s USING(fact_id)`).all();
    writeReferences(db, facts.map(row => ({ ...row, payload: JSON.parse(String(row.metadata)) } as Fact)));
  }
}

function writeReferences(db: DatabaseSync, facts: readonly Fact[]): void {
  const insert = prepare(db, 'INSERT OR IGNORE INTO search_references VALUES (?, ?, ?, ?)');
  for (const fact of facts) {
    const entity = fact.kind.split('.')[0];
    if (!SEARCH_ENTITIES.has(entity)) continue;
    const payload = (fact.payload ?? JSON.parse(String(prepare(db, 'SELECT metadata FROM search_sources WHERE fact_id = ?')
      .get(fact.fact_id)?.metadata ?? '{}'))) as Record<string, JsonValue>;
    const written = new Set<string>();
    const add = (direction: string, key: string) => {
      const reference = `${direction}:${key}`;
      if (!written.has(reference)) { insert.run(fact.fact_id, fact.subject, direction, key); written.add(reference); }
    };
    const reference = (direction: string, entity: string, value: JsonValue | undefined) => {
      if (typeof value === 'string') add(direction, `${entity}:${value}`);
    };
    add('offers', fact.subject);
    if (entity === 'conversation' || entity === 'message') {
      reference('offers', entity, payload.native_id);
      if (typeof payload.provider === 'string' && typeof payload.native_id === 'string') {
        reference('offers', entity, createNativeId(payload.provider, payload.native_id));
        if (entity === 'message') reference('needs', 'membership', createNativeId(payload.provider, payload.native_id));
      }
    }
    if (entity === 'conversation') reference('needs', 'task', payload.task_id);
    if (entity === 'run') {
      reference('needs', 'conversation', payload.conversation_id);
      if (typeof payload.conversation_id === 'string' && typeof payload.generation === 'number') {
        reference('offers', 'run', `${payload.conversation_id}:${payload.generation}`);
      }
    }
    if (entity === 'artifact') {
      reference('needs', 'run', payload.run_id);
      if (typeof payload.version === 'number') {
        add('offers', `${fact.subject}@${payload.version}`);
        if (typeof payload.run_id === 'string') add('offers', `artifact-version:${JSON.stringify([payload.run_id, payload.version])}`);
      }
    }
    if (entity === 'finding') reference('needs', 'artifact', payload.artifact_id);
    if (entity === 'message') {
      reference('needs', 'run', payload.run_id);
      reference('needs', 'membership', fact.subject.slice('message:'.length));
      reference('needs', 'membership', payload.native_id);
    }
    if (entity === 'message_membership') {
      reference('needs', 'conversation', payload.conversation_id);
      reference('needs', 'message', payload.message_id);
      reference('offers', 'membership', payload.message_id);
    }
    if (entity === 'alias' && typeof payload.entity_id === 'string') {
      if (/^(task|conversation|run):/.test(payload.entity_id)) add('needs', payload.entity_id);
      else for (const target of ['task', 'conversation', 'run']) reference('needs', target, payload.entity_id);
    }
  }
}

function expandReferences(db: DatabaseSync, seeds: Set<string>, upstream: boolean): Set<string> {
  const subjects = new Set(seeds);
  let frontier = [...subjects];
  const peers = prepare(db, `SELECT DISTINCT target.subject FROM search_references origin
    JOIN search_references target ON target.key = origin.key
    WHERE origin.subject IN (SELECT value FROM json_each(?))
    AND ((origin.direction = '${upstream ? 'needs' : 'offers'}' AND target.direction = '${upstream ? 'offers' : 'needs'}')
      OR (origin.direction = 'offers' AND target.direction = 'offers'))`);
  while (frontier.length) {
    const next: string[] = [];
    for (const row of peers.all(JSON.stringify(frontier))) {
      const subject = String(row.subject);
      if (!subjects.has(subject)) { subjects.add(subject); next.push(subject); }
    }
    frontier = next;
  }
  return subjects;
}

// 本文を残さずに、保持整理後も関係と検索先を再構築できる識別情報だけを持つ。
export function initializeSearch(db: DatabaseSync, options: { disableFts?: boolean } = {}): SearchMode {
  db.exec(`CREATE TABLE IF NOT EXISTS search_sources (fact_id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS search_state (id INTEGER PRIMARY KEY CHECK(id = 1), mode TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS search_documents (
      id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
      body TEXT, reason TEXT, conversation_id TEXT, run_id TEXT, message_id TEXT,
      project TEXT, provider TEXT, source_ts TEXT NOT NULL, confidence TEXT NOT NULL,
      identifiers TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_fact ON search_documents(fact_id);
    CREATE INDEX IF NOT EXISTS search_subject ON search_documents(subject);
    CREATE TABLE IF NOT EXISTS search_body_sources (
      document_id TEXT NOT NULL, fact_id TEXT NOT NULL, PRIMARY KEY(document_id, fact_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS search_body_fact ON search_body_sources(fact_id);
    CREATE TABLE IF NOT EXISTS search_dirty (subject TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS search_payload_changed AFTER UPDATE OF payload ON facts BEGIN
      INSERT OR IGNORE INTO search_dirty VALUES (NEW.subject); END;
    CREATE TRIGGER IF NOT EXISTS search_payload_removed AFTER UPDATE OF payload ON facts
    WHEN NEW.payload IS NULL BEGIN
      UPDATE search_documents SET body = NULL, reason = 'retention' WHERE fact_id = NEW.fact_id
        OR id IN (SELECT document_id FROM search_body_sources WHERE fact_id = NEW.fact_id);
    END;
    CREATE TRIGGER IF NOT EXISTS search_sources_deleted AFTER DELETE ON search_documents BEGIN
      DELETE FROM search_body_sources WHERE document_id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS search_fact_deleted AFTER DELETE ON facts BEGIN
      DELETE FROM search_documents WHERE fact_id = OLD.fact_id;
      DELETE FROM search_sources WHERE fact_id = OLD.fact_id; END;`);
  const toolFlag = (payload: string) => `(json_type(${payload}, '$.tool_output') IS NOT NULL OR EXISTS (
    SELECT 1 FROM json_each(${payload}, '$.body') WHERE CASE WHEN json_valid(value)
      THEN json_extract(value, '$.type') IN ('tool_result', 'tool_output') ELSE 0 END)) `;
  const metadata = `json_object(${METADATA_FIELDS.flatMap(field => [`'${field}'`, `json_extract(OLD.payload, '$.${field}')`]).join(',')}, 'has_tool_output', ${toolFlag('OLD.payload')})`;
  // 通常の挿入では抽出しない。未反映の本文が消される直前だけ識別情報を退避する。
  db.exec(`DROP TRIGGER IF EXISTS search_source_created;
    CREATE TRIGGER IF NOT EXISTS search_source_retained BEFORE UPDATE OF payload ON facts
    WHEN NEW.payload IS NULL AND OLD.payload IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM search_sources WHERE fact_id = OLD.fact_id) BEGIN
      INSERT INTO search_sources VALUES (OLD.fact_id, ${metadata}); END;`);
  initializeReferences(db);
  writeSources(db, db.prepare(`SELECT * FROM facts WHERE (${SOURCE_FILTER}) AND fact_id NOT IN (SELECT fact_id FROM search_sources)`).all()
    .map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact)));
  function useSubstring(): SearchMode {
    // 以前の FTS 索引が残っていても、利用不能のモジュールを更新しない。
    db.exec(`DROP TRIGGER IF EXISTS search_fts_insert;
      DROP TRIGGER IF EXISTS search_fts_delete;
      DROP TRIGGER IF EXISTS search_fts_update;`);
    db.prepare("INSERT OR REPLACE INTO search_state VALUES (1, 'substring')").run();
    return 'substring';
  }
  if (options.disableFts) return useSubstring();
  // 旧 tokenizer の索引は、秘匿済みの検索文書から作り直す。
  const existingFts = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").get();
  if (existingFts && (!String(existingFts.sql).includes("tokenize='trigram'")
    || !String(existingFts.sql).includes('identifiers UNINDEXED'))) {
    db.exec(`DROP TRIGGER IF EXISTS search_fts_insert;
      DROP TRIGGER IF EXISTS search_fts_delete;
      DROP TRIGGER IF EXISTS search_fts_update;
      DROP TABLE search_fts;`);
  }
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(id UNINDEXED, body, identifiers UNINDEXED, tokenize='trigram')");
    // IF NOT EXISTS だけでは、既存表のモジュールが利用できるか確かめられない。
    db.prepare('SELECT rowid FROM search_fts LIMIT 1').all();
  }
  catch (error) {
    if (!(error instanceof Error) || !/no such module: fts5|no such tokenizer: trigram/i.test(error.message)) throw error;
    return useSubstring();
  }
  createFtsTriggers(db);
  if (db.prepare('SELECT mode FROM search_state WHERE id = 1').get()?.mode === 'substring') {
    db.exec('DELETE FROM search_fts');
  }
  db.exec(`INSERT INTO search_fts(rowid, id, body, identifiers)
    SELECT rowid, id, body, identifiers FROM search_documents WHERE rowid NOT IN (SELECT rowid FROM search_fts)`);
  db.prepare("INSERT OR REPLACE INTO search_state VALUES (1, 'fts5')").run();
  return 'fts5';
}

function createFtsTriggers(db: DatabaseSync): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS search_fts_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid, id, body, identifiers) VALUES (NEW.rowid, NEW.id, NEW.body, NEW.identifiers); END;
    CREATE TRIGGER IF NOT EXISTS search_fts_delete AFTER DELETE ON search_documents BEGIN
      DELETE FROM search_fts WHERE rowid = OLD.rowid; END;
    CREATE TRIGGER IF NOT EXISTS search_fts_update AFTER UPDATE ON search_documents BEGIN
      DELETE FROM search_fts WHERE rowid = OLD.rowid;
      INSERT INTO search_fts(rowid, id, body, identifiers) VALUES (NEW.rowid, NEW.id, NEW.body, NEW.identifiers); END;`);
}

function readText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
function splitMessage(body: JsonValue | undefined): { message: string; tool: string } {
  if (!Array.isArray(body)) return { message: getMessageText(body), tool: '' };
  const tools = body.filter(block => block && typeof block === 'object' && !Array.isArray(block)
    && ['tool_result', 'tool_output'].includes(String(block.type)));
  return { message: getMessageText(body.filter(block => !tools.includes(block))), tool: getMessageText(tools) };
}

/** 投影と同じトランザクションで呼び、変わった索引の行だけを反映する。 */
export function refreshSearch(db: DatabaseSync, added?: readonly Fact[], allFacts?: readonly Fact[]): void {
  const initial = added?.[0]?.seq === 1;
  const dirty = prepare(db, 'SELECT subject FROM search_dirty').all();
  if (added && dirty.length) {
    const changed = prepare(db, 'SELECT * FROM facts WHERE subject IN (SELECT subject FROM search_dirty)').all()
      .map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
    added = [...added, ...changed];
  }
  if (added?.length === 0) return;
  const bulk = !added || initial;
  const bulkFts = bulk && prepare(db, 'SELECT mode FROM search_state WHERE id = 1').get()?.mode === 'fts5';
  if (bulkFts) db.exec(`DROP TRIGGER IF EXISTS search_fts_insert;
    DROP TRIGGER IF EXISTS search_fts_delete; DROP TRIGGER IF EXISTS search_fts_update;`);
  // 空の参照表は行ごとの索引更新を避け、投入後にまとめて索引を作る。
  const bulkReferences = bulk && !prepare(db, 'SELECT 1 FROM search_references LIMIT 1').get();
  if (bulkReferences) db.exec('DROP INDEX search_reference_subject; DROP INDEX search_reference_key;');
  writeSources(db, added ?? allFacts ?? prepare(db, 'SELECT * FROM facts ORDER BY seq').all()
    .map(row => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact)));
  if (bulkReferences) db.exec(`CREATE INDEX search_reference_subject ON search_references(subject, direction, key);
    CREATE INDEX search_reference_key ON search_references(key, direction, subject);`);
  let subjects: Set<string> | undefined;
  let facts: StoredRow[];
  // 初回の反映は全件が追加分なので、参照の探索を省いて直接構築する。
  if (added && !initial) {
    const relevant = added.filter(fact => {
      if (!/^(message|message_membership|task|conversation|run|artifact|finding|alias)\./.test(fact.kind)) return false;
      // 状態だけの更新は、検索先・絞り込み・本文のいずれも変えない。
      return !fact.kind.startsWith('run.') || Boolean(fact.supersedes)
        || fact.kind === 'run.created' || Boolean(fact.payload && 'conversation_id' in fact.payload);
    });
    if (!relevant.length) { db.exec('DELETE FROM search_dirty'); return; }
    const seeds = relevant.filter(fact => !fact.kind.startsWith('task.')
      || fact.payload && 'project' in fact.payload);
    // 保持整理で退避された未反映の識別情報にも参照を付ける。
    writeReferences(db, relevant);
    subjects = expandReferences(db, new Set(seeds.map(fact => fact.subject)), false);
    for (const fact of relevant) subjects.add(fact.subject);
    const context = expandReferences(db, subjects, true);
    // 作業とその別名の移動先は、その作業に属する会話の先頭である。
    const tasks = [...context].filter(subject => subject.startsWith('task:'));
    const destinations = prepare(db, `SELECT DISTINCT subject FROM search_references
      WHERE direction = 'needs' AND key IN (SELECT value FROM json_each(?))
      AND (subject LIKE 'conversation:%' OR subject LIKE 'alias:%')`).all(JSON.stringify(tasks));
    for (const row of destinations) {
      const subject = String(row.subject);
      context.add(subject);
      if (relevant.some(fact => fact.kind.startsWith('conversation.')) && subject.startsWith('alias:')) subjects.add(subject);
    }
    if (relevant.some(fact => fact.kind.startsWith('conversation.'))) {
      for (const subject of tasks) subjects.add(subject);
    }
    facts = prepare(db, `SELECT f.*, s.metadata FROM facts f LEFT JOIN search_sources s USING(fact_id)
      WHERE subject IN (SELECT value FROM json_each(?)) ORDER BY seq`).all(JSON.stringify([...context]));
  } else {
    const complete = allFacts ?? (initial ? added : undefined);
    facts = complete ? complete.map(fact => ({ ...fact, payload: fact.payload }))
      : prepare(db, `SELECT f.*, s.metadata FROM facts f LEFT JOIN search_sources s USING(fact_id) ORDER BY seq`).all();
    if (facts.some(row => row.payload === null)) {
      const purged = prepare(db, 'SELECT fact_id, metadata FROM search_sources WHERE fact_id IN (SELECT fact_id FROM facts WHERE payload IS NULL)').all();
      const metadata = new Map(purged.map(row => [String(row.fact_id), row.metadata]));
      for (const row of facts) if (row.payload === null) row.metadata = metadata.get(String(row.fact_id));
      writeReferences(db, facts.filter(row => row.payload === null)
        .map(row => ({ ...row, payload: JSON.parse(String(row.metadata ?? '{}')) } as Fact)));
    }
  }
  facts = facts.filter(row => SEARCH_ENTITIES.has(String(row.kind).split('.')[0]));
  const decoded = facts.map(row => ({ ...row, payload: row.payload === null ? null
    : typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } as Fact));
  const contextFacts = decoded.map((fact, index) => ({ ...fact,
    payload: fact.payload ?? Object.fromEntries(Object.entries(JSON.parse(String(facts[index].metadata ?? '{}')))
      .filter(([, value]) => value !== null)) } as Fact));
  const preparedContext = prepareProjectionFacts(contextFacts);
  const metadataById = new Map(preparedContext.map(fact => [fact.fact_id, fact.payload]));
  const originalById = new Map(decoded.map(fact => [fact.fact_id, fact]));
  function readFieldSource(fact: Fact, field: string, seen = new Set<string>()): string | undefined {
    if (seen.has(fact.fact_id)) return undefined;
    seen.add(fact.fact_id);
    if (fact.payload && field in fact.payload) return fact.fact_id;
    const previous = fact.supersedes ? originalById.get(fact.supersedes) : undefined;
    return previous && previous.subject === fact.subject ? readFieldSource(previous, field, seen) : undefined;
  }
  function hasPurgedAncestor(fact: Fact, seen = new Set<string>()): boolean {
    if (seen.has(fact.fact_id)) return false;
    seen.add(fact.fact_id);
    if (fact.payload === null) return true;
    const previous = fact.supersedes ? originalById.get(fact.supersedes) : undefined;
    return Boolean(previous && previous.subject === fact.subject && hasPurgedAncestor(previous, seen));
  }
  const effective = decoded.some(fact => fact.payload === null) ? prepareProjectionFacts(decoded)
    .map(fact => originalById.get(fact.fact_id)?.payload === null ? { ...fact, payload: null } : fact) : preparedContext;
  // 通常の全件経路は投影表を読む。保持整理後は識別情報だけで失われた文脈を補う。
  const restoreContext = subjects || decoded.some(fact => fact.payload === null);
  const projection = restoreContext ? {
    // 検索は会話の識別と作業だけを使うため、名前の候補のために本文を投影しない。
    ...projectConversations(contextFacts, new Map()),
    message_memberships: projectMessages(contextFacts).message_memberships,
    runs: projectRuns(contextFacts),
    artifacts: projectArtifacts(contextFacts),
  } : {
    conversations: prepare(db, 'SELECT id, provider, task_id FROM conversations ORDER BY id').all() as { id: string; provider?: string; task_id?: string }[],
    tasks: prepare(db, 'SELECT id, project FROM tasks ORDER BY id').all() as { id: string; project?: string }[],
    message_memberships: prepare(db, 'SELECT message_id, conversation_id, active FROM message_memberships ORDER BY id').all() as { message_id?: string; conversation_id?: string; active?: number }[],
    runs: prepare(db, 'SELECT id, conversation_id, generation FROM runs ORDER BY id').all() as { id: string; conversation_id?: string; generation?: number }[],
    artifacts: prepare(db, 'SELECT id, run_id FROM artifacts ORDER BY run_id, version, id').all() as { id: string; run_id: string }[],
  };
  const memberships = new Map<string, string>();
  for (const row of projection.message_memberships) {
    if (row.active && row.message_id && row.conversation_id && !memberships.has(row.message_id)) memberships.set(row.message_id, row.conversation_id);
  }
  const conversations = new Map(projection.conversations.map(row => [row.id, row]));
  const conversationIds = projectConversationIds(contextFacts.filter(fact => fact.kind.startsWith('conversation.')));
  const tasks = new Map(projection.tasks.map(row => [row.id, row]));
  const runs = new Map(projection.runs.map(row => [row.id, row]));
  const runsByConversation = new Map(projection.runs.map(row => [JSON.stringify([row.conversation_id, row.generation]), row]));
  for (const fact of preparedContext) {
    if (!fact.kind.startsWith('run.')) continue;
    const payload = fact.payload as { conversation_id?: string; generation?: number };
    const run = runsByConversation.get(JSON.stringify([payload.conversation_id, payload.generation]));
    if (run) runs.set(fact.subject.slice('run:'.length), run);
  }
  const artifacts = new Map(projection.artifacts.map(row => [row.id, row]));
  const columns = ['id', 'fact_id', 'subject', 'kind', 'body', 'reason', 'conversation_id', 'run_id', 'message_id', 'project', 'provider', 'source_ts', 'confidence', 'identifiers'];
  const insert = prepare(db, `INSERT INTO search_documents (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
    ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(column => `${column}=excluded.${column}`).join(',')}
    WHERE ${columns.slice(1).map(column => `search_documents.${column} IS NOT excluded.${column}`).join(' OR ')}`);
  const retained = new Set<string>();
  for (const fact of effective) {
    if (subjects && !subjects.has(fact.subject)) continue;
    const payload = (fact.payload ?? {}) as Record<string, JsonValue>;
    const meta = (metadataById.get(fact.fact_id) ?? {}) as Record<string, JsonValue>;
    const entity = fact.kind.split('.')[0];
    const subjectId = fact.subject.slice(entity.length + 1);
    const messageId = entity === 'message' ? meta.provider && meta.native_id
      ? createNativeId(String(meta.provider), String(meta.native_id)) : subjectId : null;
    let runId = typeof meta.run_id === 'string' ? meta.run_id : null;
    if (entity === 'finding') runId = artifacts.get(String(meta.artifact_id))?.run_id ?? null;
    let conversationId = runId ? runs.get(runId)?.conversation_id ?? null : null;
    if (conversationId) conversationId = conversationIds.get(conversationId) ?? conversationId;
    if (messageId) conversationId = memberships.get(messageId) ?? null;
    if (entity === 'alias') {
      const target = String(meta.entity_id ?? '').replace(/^(task|conversation|run):/, '');
      conversationId = conversations.has(target) ? target : runs.get(target)?.conversation_id
        ?? projection.conversations.find(row => row.task_id === target)?.id ?? null;
      if (runs.has(target)) runId = target;
    }
    if (entity === 'task') conversationId = projection.conversations.find(row => row.task_id === subjectId)?.id ?? null;
    const conversation = conversationId ? conversations.get(conversationId) : undefined;
    const aliasTarget = entity === 'alias' ? String(meta.entity_id ?? '').replace(/^task:/, '') : '';
    const taskId = entity === 'task' ? subjectId : tasks.has(aliasTarget) ? aliasTarget : conversation?.task_id;
    const projectId = tasks.get(taskId ?? '')?.project ?? (typeof meta.project === 'string' ? meta.project : null)
      ?? (typeof meta.repository_id === 'string' ? meta.repository_id : null);
    const provider = conversation?.provider ?? (typeof meta.provider === 'string' ? meta.provider : null);
    // 発言から実行を推定すると、再開した会話で誤帰属する。明示の参照だけを採用する。
    const message = splitMessage(payload.body);
    const entries: [SearchKind, string][] = entity === 'message'
      ? meta.role === 'tool' ? [['tool_output', [message.message, message.tool, readText(payload.tool_output)].filter(Boolean).join('\n')]]
        : [['message', message.message], ...((message.tool || payload.tool_output !== undefined || meta.has_tool_output) ? [['tool_output', [message.tool, readText(payload.tool_output)].filter(Boolean).join('\n')] as [SearchKind, string]] : [])]
      : entity === 'artifact' ? [['diff', readText(payload.diff ?? payload.patch ?? payload.full_diff)]]
        : entity === 'finding' ? [['finding', readText(payload.body)]]
          : entity === 'task' ? [['task', readText(payload.name)]]
            : entity === 'alias' ? [['alias', readText(payload.name)]] : [];
    for (const [kind, text] of entries) {
      const id = `${fact.fact_id}:${kind}`;
      retained.add(id);
      const row = { id, fact_id: fact.fact_id, subject: fact.subject, kind,
        body: text || null, reason: !text && hasPurgedAncestor(originalById.get(fact.fact_id)!) ? 'retention' : !text ? 'storage_scope_or_unavailable' : null,
        conversation_id: conversationId, run_id: runId, message_id: messageId,
        project: projectId, provider, source_ts: fact.source_ts, confidence: fact.confidence,
        identifiers: [...new Set([fact.subject, messageId, conversationId, runId, taskId, projectId].filter(Boolean))].join(' ') };
      insert.run(...columns.map(column => row[column as keyof typeof row] as SQLInputValue));
      prepare(db, 'DELETE FROM search_body_sources WHERE document_id = ?').run(id);
      const fields = kind === 'tool_output' ? ['body', 'tool_output'] : kind === 'diff' ? ['diff', 'patch', 'full_diff']
        : kind === 'message' || kind === 'finding' ? ['body'] : ['name'];
      for (const field of fields) {
        const source = readFieldSource(originalById.get(fact.fact_id)!, field);
        // 自身の本文は fact_id で消せる。継承した本文だけ出所を別表に持つ。
        if (source && source !== fact.fact_id) prepare(db, 'INSERT OR IGNORE INTO search_body_sources VALUES (?, ?)').run(id, source);
      }
    }
  }
  const remove = prepare(db, 'DELETE FROM search_documents WHERE id = ?');
  const previous = subjects ? prepare(db, 'SELECT id FROM search_documents WHERE subject IN (SELECT value FROM json_each(?))').all(JSON.stringify([...subjects]))
    : prepare(db, 'SELECT id FROM search_documents').all();
  for (const row of previous) if (!retained.has(String(row.id))) remove.run(String(row.id));
  if (bulkFts) {
    db.exec('DELETE FROM search_fts; INSERT INTO search_fts(rowid, id, body, identifiers) SELECT rowid, id, body, identifiers FROM search_documents');
    createFtsTriggers(db);
  }
  db.exec('DELETE FROM search_dirty');
}

export function searchLedger(db: DatabaseSync, input: SearchQuery, mode?: SearchMode): SearchResponse {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  if (typeof input.query !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT
    || !Number.isSafeInteger(offset) || offset < 0 || input.kind && !SEARCH_KINDS.includes(input.kind)
    || input.provider && !['claude', 'codex'].includes(input.provider)) throw new SearchValidationError('Invalid search filters');
  for (const timestamp of [input.from, input.to]) if (timestamp && !Number.isFinite(Date.parse(timestamp))) throw new SearchValidationError('Invalid search period');
  if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) throw new SearchValidationError('Invalid search period');
  const engine = mode ?? (db.prepare('SELECT mode FROM search_state WHERE id = 1').get()?.mode === 'fts5' ? 'fts5' : 'substring');
  const conditions: string[] = [];
  const values: SQLInputValue[] = [];
  const query = input.query.trim();
  if (query) {
    if (engine === 'fts5' && [...query].length >= TRIGRAM_MIN_LENGTH) {
      // 識別子は本文と異なり長い機械生成値が多いため、全文索引には載せない。
      conditions.push('(d.id IN (SELECT id FROM search_fts WHERE search_fts MATCH ?) OR instr(lower(d.identifiers), lower(?)) > 0)');
      values.push(`"${query.replaceAll('"', '""')}"`, query);
    } else {
      conditions.push("instr(lower(coalesce(d.body, '') || ' ' || d.identifiers), lower(?)) > 0"); values.push(query);
    }
  }
  for (const field of ['project', 'provider', 'kind'] as const) if (input[field]) { conditions.push(`d.${field} = ?`); values.push(input[field]!); }
  if (input.from) { conditions.push('julianday(d.source_ts) >= julianday(?)'); values.push(input.from); }
  if (input.to) { conditions.push('julianday(d.source_ts) <= julianday(?)'); values.push(input.to); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(db.prepare(`SELECT count(*) AS count FROM search_documents d ${where}`).get(...values)!.count);
  const results = db.prepare(`SELECT d.* FROM search_documents d ${where} ORDER BY julianday(source_ts) DESC, id LIMIT ? OFFSET ?`)
    .all(...values, limit, offset).map(({ identifiers: _identifiers, ...row }) => ({ ...row } as unknown as SearchResult));
  const unsupported = db.prepare("SELECT subject, payload FROM facts WHERE kind = 'observation.unsupported' ORDER BY seq DESC LIMIT ?").all(MAX_UNSUPPORTED_NOTICES)
    .map(row => ({ subject: String(row.subject), reason: row.payload === null ? 'History format unsupported' : String(JSON.parse(String(row.payload)).reason ?? 'History format unsupported') }));
  return { mode: engine, results, total, unsupported };
}
