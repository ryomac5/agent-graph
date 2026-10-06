import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { EntityKind, Fact, JsonValue } from "./facts.ts";
import { project, serializeValue } from "./projections/index.ts";
import type { Projection } from "./projections/index.ts";

export const PROJECTION_TABLES = [
  "tasks", "conversations", "relations", "runs", "connections", "messages",
  "delegations", "artifacts", "aliases", "approvals", "findings", "message_memberships",
] as const satisfies readonly (keyof Projection)[];
type ProjectionTable = typeof PROJECTION_TABLES[number];

// 差分の実体から影響する表を選ぶ。訂正と遅着の再計算には依存先の履歴も必要になる。
const PROJECTION_DEPENDENCIES = {
  tasks: ["task"],
  conversations: ["conversation", "task", "message", "message_membership"],
  relations: ["relation", "conversation"],
  runs: ["run"],
  connections: ["connection"],
  messages: ["message"],
  delegations: ["delegation", "run", "conversation"],
  artifacts: ["artifact"],
  aliases: ["alias"],
  approvals: ["approval", "artifact", "run"],
  findings: ["finding"],
  message_memberships: ["message_membership", "message", "conversation"],
} as const satisfies Record<ProjectionTable, readonly EntityKind[]>;

const JSON_COLUMNS = new Set([
  "evidence", "end_evidence", "last_evidence", "tool_output",
  "accept", "scope", "constraints", "result", "attempts", "untracked",
  "verification", "commits", "available_decisions", "request",
]);

export interface ProjectionState {
  generation: number;
  last_seq: number;
}

function readState(ledger: DatabaseSync): ProjectionState {
  const row = ledger.prepare("SELECT generation, last_seq FROM projection_state WHERE id = 1").get();
  if (!row) throw new Error("projection_state がありません");
  return { generation: Number(row.generation), last_seq: Number(row.last_seq) };
}

function readFacts(
  ledger: DatabaseSync, afterSeq = 0, throughSeq = Number.MAX_SAFE_INTEGER,
  entities?: readonly EntityKind[],
): Fact[] {
  const filter = entities ? ` AND (${entities.map(() => "kind GLOB ?").join(" OR ")})` : "";
  return ledger.prepare(`SELECT * FROM facts WHERE seq > ? AND seq <= ?${filter} ORDER BY seq`)
    .all(afterSeq, throughSeq, ...(entities?.map((entity) => `${entity}.*`) ?? [])).map((row) => ({
    ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)),
  } as Fact));
}

function encodeValue(table: string, column: string, value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (JSON_COLUMNS.has(column) || (table === "messages" && column === "body")
    || (table === "delegations" && column === "origin")) return serializeValue(value as JsonValue);
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string" || typeof value === "number") return value;
  throw new TypeError(`投影の列 ${column} の値が未対応です`);
}

function writeProjection(
  ledger: DatabaseSync, projection: Projection, replace: boolean,
  tables: readonly ProjectionTable[],
): void {
  for (const table of tables) {
    const columns = ledger.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
    const existing = new Map(replace ? []
      : ledger.prepare(`SELECT * FROM ${table}`).all().map((row) => [String(row.id), row]));
    if (replace) ledger.exec(`DELETE FROM ${table}`);
    const insert = ledger.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of projection[table]) {
      const record = row as unknown as Record<string, unknown>;
      const values = columns.map((column) => encodeValue(table, column, record[column]));
      const previous = existing.get(row.id);
      if (replace || !previous || columns.some((column, index) => previous[column] !== values[index])) {
        insert.run(...values);
      }
      existing.delete(row.id);
    }
    if (!replace) {
      const remove = ledger.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const id of existing.keys()) remove.run(id);
    }
  }
}

function updateProjection(ledger: DatabaseSync, sinceSeq?: number): ProjectionState {
  ledger.exec("BEGIN IMMEDIATE");
  try {
    const state = readState(ledger);
    if (sinceSeq !== undefined && sinceSeq > state.last_seq) {
      throw new RangeError("未反映の事実を飛ばすことはできません");
    }
    const added = readFacts(ledger, sinceSeq === undefined ? 0 : state.last_seq);
    if (sinceSeq === undefined || added.length > 0) {
      const changed = new Set(added.map((fact) => fact.kind.split(".")[0]));
      const tables = sinceSeq === undefined ? PROJECTION_TABLES : PROJECTION_TABLES.filter((table) =>
        PROJECTION_DEPENDENCIES[table].some((entity) => changed.has(entity)));
      const entities = [...new Set(tables.flatMap((table) => [...PROJECTION_DEPENDENCIES[table]]))];
      const facts = sinceSeq === undefined ? added : [...readFacts(ledger, 0, state.last_seq, entities), ...added];
      writeProjection(ledger, project(facts), sinceSeq === undefined, tables);
      state.last_seq = added.at(-1)?.seq ?? 0;
      if (sinceSeq === undefined) state.generation += 1;
      ledger.prepare("UPDATE projection_state SET generation = ?, last_seq = ? WHERE id = 1")
        .run(state.generation, state.last_seq);
    }
    ledger.exec("COMMIT");
    return state;
  } catch (error) {
    ledger.exec("ROLLBACK");
    throw error;
  }
}

/** 台帳の SQLite 接続を受け取り、全表と世代を同じトランザクションで再構築する。 */
export function rebuild(ledger: DatabaseSync): ProjectionState {
  return updateProjection(ledger);
}

/**
 * sinceSeq は反映済みの位置。再送は許し、未反映の範囲を飛ばす指定は拒む。
 * 訂正と実体間の依存の計算には過去の事実も使い、変更した投影の行だけを書き込む。
 */
export function applyIncremental(ledger: DatabaseSync, sinceSeq: number): ProjectionState {
  if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) {
    throw new RangeError("sinceSeq は非負の安全な整数で指定してください");
  }
  return updateProjection(ledger, sinceSeq);
}
