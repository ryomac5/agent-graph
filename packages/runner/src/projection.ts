import type { StatementSync, SQLInputValue } from "node:sqlite";
import { applyIncremental, type Ledger, type Fact, type Projection } from "../../core/src/ledger/index.ts";
import { readLedgerDatabase } from "../../core/src/ledger/repository.ts";
import type { DelegationProjection } from "../../core/src/ledger/projections/delegations.ts";
import { createNativeId, serializeValue } from "../../core/src/ledger/projections/relations.ts";

const STORES = new WeakMap<Ledger, RunnerProjection>();
export function readProjection(ledger: Ledger): RunnerProjection {
  let store = STORES.get(ledger);
  if (!store) { store = new RunnerProjection(ledger); STORES.set(ledger, store); }
  store.sync();
  return store;
}

export class RunnerProjection {
  private database;
  private statements = new Map<string, StatementSync>();
  private seq = -1;
  constructor(ledger: Ledger) { this.database = readLedgerDatabase(ledger); }
  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.database.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }
  sync(): void {
    const seq = this.lastSeq();
    const state = Number(this.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq);
    if (this.seq < 0 || seq !== state) applyIncremental(this.database, state);
    this.seq = seq;
  }
  lastSeq(): number { return Number(this.prepare("SELECT seq FROM facts ORDER BY seq DESC LIMIT 1").get()?.seq ?? 0); }
  timestamp(): number { return Date.parse(String(this.prepare("SELECT source_ts FROM facts ORDER BY julianday(source_ts) DESC LIMIT 1").get()?.source_ts ?? "1970-01-01")); }
  records<P extends object>(entity: string, where = "", values: SQLInputValue[] = []): (Partial<P> & { id: string })[] {
    const field = ["conversation_id", "run_id", "task_id", "worktree_id", "native_id", "state"].find((column) => where.includes(column));
    const index = field ? `INDEXED BY entity_${field === "native_id" ? "native" : field.replace("_id", "")}` : "";
    return this.prepare(`SELECT data FROM entity_records ${index} WHERE entity = ? ${where ? `AND ${where}` : ""} ORDER BY id`).all(entity, ...values)
      .map((row) => JSON.parse(String(row.data)));
  }
  record<P extends object>(entity: string, id: string): (Partial<P> & { id: string }) | undefined {
    return this.records<P>(entity, "id = ?", [id])[0];
  }
  rows<T extends keyof Projection>(table: T, where = "", values: SQLInputValue[] = []): Projection[T] {
    return this.prepare(`SELECT p.data FROM ${table} CROSS JOIN projection_records p ON p.projection = '${table}' AND p.entity_id = ${table}.id ${where ? `WHERE ${where}` : ""} ORDER BY ${table}.id`).all(...values)
      .map((row) => JSON.parse(String(row.data))) as Projection[T];
  }
  row<T extends keyof Projection>(table: T, id: string): Projection[T][number] | undefined { return this.rows(table, "id = ?", [id])[0]; }
  delegations(where = "", values: SQLInputValue[] = []): DelegationProjection[] { return this.rows("delegations", where, values); }
  delegationForRun(runId: string): DelegationProjection | undefined {
    const row = this.prepare("SELECT delegation_id FROM delegation_runs WHERE run_id = ?").get(runId);
    return row ? this.row("delegations", String(row.delegation_id)) : undefined;
  }
  runSubject(conversationId: string, generation: number): string | undefined {
    const row = this.prepare("SELECT subject_id FROM run_subjects WHERE conversation_id = ? AND generation = ?").get(conversationId, generation);
    return row ? String(row.subject_id) : undefined;
  }
  receipt(id: string): { hash: string; result: import("../../core/src/ledger/facts.ts").JsonValue; seq: number } | undefined {
    const row = this.prepare("SELECT data, seq FROM command_receipts WHERE id = ?").get(id);
    return row ? { ...JSON.parse(String(row.data)), seq: Number(row.seq) } : undefined;
  }
  commitResults(runIds: string[]): { run_id: string; result: import("./artifacts/index.ts").CommitResult }[] {
    return this.prepare("SELECT run_id, data FROM run_commit_results WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY seq").all(JSON.stringify(runIds))
      .map((row) => ({ run_id: String(row.run_id), result: JSON.parse(String(row.data)) }));
  }
  facts(where: string, values: SQLInputValue[] = []): Fact[] {
    return this.prepare(`SELECT * FROM facts WHERE ${where} ORDER BY seq`).all(...values)
      .map((row) => ({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact));
  }
  fact(id: string): Fact | undefined { return this.facts("fact_id = ?", [id])[0]; }
  subjectFacts(subject: string): Fact[] { return this.facts("subject = ?", [subject]); }
  hasSubject(subject: string): boolean { return !!this.prepare("SELECT 1 FROM facts WHERE subject = ? LIMIT 1").get(subject); }
  lastFact(subject: string): Fact | undefined {
    const row = this.prepare("SELECT * FROM facts WHERE subject = ? ORDER BY seq DESC LIMIT 1").get(subject);
    return row ? { ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact : undefined;
  }
  conversation<P extends object>(id: string): (Partial<P> & { id: string }) | undefined {
    const direct = this.record<P>("conversation", id);
    if (direct) return direct;
    const parsed = JSON.parse(id.startsWith("[") ? id : "null");
    if (!Array.isArray(parsed)) return undefined;
    return this.records<P>("conversation", "provider = ? AND native_id = ?", parsed).sort((a, b) =>
      Number((b as { origin?: string }).origin === "managed") - Number((a as { origin?: string }).origin === "managed"))[0];
  }
  relation(id: string) {
    const direct = this.row("relations", id);
    if (direct) return direct;
    const record = this.record<{ type: string; from_id: string; to_id: string; evidence: import("../../core/src/ledger/facts.ts").JsonValue }>("relation", id);
    if (!record?.type || !record.from_id || !record.to_id || record.evidence === undefined) return undefined;
    return this.row("relations", JSON.stringify([record.type, this.nativeConversationId(record.from_id), this.nativeConversationId(record.to_id), serializeValue(record.evidence)]));
  }
  nativeConversationId(id: string): string {
    const record = this.record<{ provider: "claude" | "codex"; native_id: string }>("conversation", id);
    return record?.provider && record.native_id ? createNativeId(record.provider, record.native_id) : id;
  }
  messages(conversationId: string): (Record<string, unknown> & { id: string; body?: import("../../core/src/ledger/facts.ts").JsonValue; phase?: string; role?: string })[] {
    return this.prepare(`SELECT m.data FROM entity_records p INDEXED BY entity_conversation JOIN entity_records m ON m.entity = 'message' AND m.id = json_extract(p.data, '$.message_id')
      WHERE p.entity = 'message_membership' AND p.conversation_id = ? AND json_extract(p.data, '$.active') = 1 ORDER BY m.last_seq, m.id`).all(conversationId)
      .map((row) => JSON.parse(String(row.data)));
  }
  successors(id: string): Set<string> {
    return new Set(this.prepare(`WITH RECURSIVE successors(id) AS (SELECT ? UNION SELECT a.id FROM successors s JOIN artifacts previous ON previous.id = s.id JOIN artifacts a ON a.previous_artifact_id = s.id OR (a.run_id = previous.run_id AND a.version > previous.version))
      SELECT id FROM successors`).all(id).map((row) => String(row.id)));
  }
  count(sql: string, values: SQLInputValue[] = []): number { return Number(this.prepare(sql).get(...values)!.count); }
}
