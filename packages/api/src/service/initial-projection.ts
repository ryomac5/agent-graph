import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { rebuild, projectNames, projectConversations, projectMessages, projectRuns, projectConnections,
  projectDelegations, projectArtifacts, projectApprovals, projectFindings, serializeValue,
  encodeNameOrder, extractProvisionalName, compareText, type Fact, type JsonValue,
  type MessageProjection } from "../../../core/src/ledger/index.ts";
import { PROJECTION_TABLES } from "../../../core/src/ledger/rebuild.ts";
import { refreshSearch } from "../../../core/src/ledger/search.ts";

const JSON_COLUMNS = new Set(["evidence", "end_evidence", "last_evidence", "tool_output", "accept", "scope",
  "constraints", "result", "attempts", "untracked", "verification", "commits", "available_decisions", "request", "launch"]);

function encodeColumn(table: string, column: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (JSON_COLUMNS.has(column) || table === "messages" && column === "body" || table === "delegations" && column === "origin") {
    return serializeValue(value as JsonValue);
  }
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || typeof value === "number") return value;
  throw new TypeError(`投影の列 ${column} の値が未対応です`);
}

function projectInitialConversations(facts: Fact[], projection: MessageProjection) {
  const conversationsByMessage = new Map<string, Set<string>>();
  for (const membership of projection.message_memberships) {
    if (!membership.active || !membership.message_id || !membership.conversation_id) continue;
    const conversations = conversationsByMessage.get(membership.message_id) ?? new Set<string>();
    conversations.add(membership.conversation_id);
    conversationsByMessage.set(membership.message_id, conversations);
  }
  const names = new Map<string, string>();
  const messages = [...projection.messages].sort((left, right) => Date.parse(left.source_ts) - Date.parse(right.source_ts)
    || compareText(left.source_event_id, right.source_event_id) || compareText(left.id, right.id));
  for (const message of messages) {
    const name = extractProvisionalName(message.body);
    if (!name) continue;
    for (const id of conversationsByMessage.get(message.id) ?? []) if (!names.has(id)) names.set(id, name);
  }
  // 発言の投影を再利用し、会話の仮名のために同じ本文を再投影しない。
  return projectConversations(facts, names);
}

/** 空の投影への投入では二次索引も同じ取引内で一括構築する。 */
export function rebuildInitialProjection(db: DatabaseSync) {
  const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
    AND tbl_name IN ('message_memberships', 'conversation_name_candidates',
      'search_documents', 'search_body_sources')`).all();
  const connection = new Proxy(db, { get(target, key) {
    if (key === "exec") return (sql: string) => {
      if (sql === "BEGIN IMMEDIATE") {
        target.exec(sql);
        for (const index of indexes) target.exec(`DROP INDEX "${String(index.name).replaceAll('"', '""')}"`);
      } else if (sql === "COMMIT") {
        for (const index of indexes) target.exec(String(index.sql));
        target.exec(sql);
      } else target.exec(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const facts = db.prepare("SELECT * FROM facts ORDER BY seq").all().map((row) => ({ ...row,
    payload: row.payload === null ? null : JSON.parse(String(row.payload)),
  } as Fact));
  // 訂正の実体をまたぐ依存は core の全体再構築に任せる。
  if (facts.some((fact) => fact.supersedes)) return rebuild(connection);
  const groups = new Map<string, Fact[]>();
  for (const fact of facts) {
    const entity = fact.kind.split(".")[0];
    const group = groups.get(entity) ?? [];
    group.push(fact);
    groups.set(entity, group);
  }
  const collect = (...entities: string[]) => entities.flatMap((entity) => groups.get(entity) ?? []);
  // 大量の発言を、無関係な実体の投影でも整列する処理を避ける。
  const messages = projectMessages(collect("message", "message_membership", "conversation"));
  const projection = {
    ...projectNames(collect("task", "alias")),
    ...projectInitialConversations(collect("task", "conversation", "relation"), messages),
    ...messages,
    runs: projectRuns(collect("run")), connections: projectConnections(collect("connection")),
    delegations: projectDelegations(collect("delegation", "conversation", "run")),
    artifacts: projectArtifacts(collect("artifact")), approvals: projectApprovals(collect("approval", "artifact", "run")),
    findings: projectFindings(collect("finding")),
  };
  connection.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare("SELECT generation, last_seq FROM projection_state WHERE id = 1").get()!;
    db.exec("DELETE FROM message_name_inputs; DELETE FROM conversation_name_candidates");
    for (const table of PROJECTION_TABLES) {
      db.exec(`DELETE FROM ${table}`);
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
      const insert = db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
      for (const row of projection[table]) {
        const record = row as unknown as Record<string, unknown>;
        insert.run(...columns.map((column) => encodeColumn(table, column, record[column])));
      }
    }
    const insertName = db.prepare("INSERT INTO message_name_inputs VALUES (?, ?, ?, ?, ?)");
    for (const message of messages.messages) insertName.run(message.id, Date.parse(message.source_ts),
      encodeNameOrder(message.source_event_id), extractProvisionalName(message.body), encodeNameOrder(message.id));
    db.exec(`INSERT INTO conversation_name_candidates
      SELECT m.id, m.conversation_id, m.message_id, n.source_time, n.source_event_id, n.name, n.message_order
      FROM message_memberships m JOIN message_name_inputs n ON n.id = m.message_id
      WHERE m.active = 1 AND m.conversation_id IS NOT NULL AND n.name <> ''`);
    const result = { generation: Number(state.generation) + 1, last_seq: facts.at(-1)?.seq ?? 0 };
    db.prepare("UPDATE projection_state SET generation = ?, last_seq = ? WHERE id = 1").run(result.generation, result.last_seq);
    refreshSearch(db, undefined, facts);
    connection.exec("COMMIT");
    return result;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
