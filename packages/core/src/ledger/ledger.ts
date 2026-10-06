import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CONFIDENCES, ENTITY_KINDS, SOURCES } from "./facts.ts";
import type { Fact, FactInput, JsonValue } from "./facts.ts";
import { redactValue, validateRules } from "./redact.ts";
import type { RedactionRules } from "./redact.ts";
import { initializeSchema, SCHEMA_VERSION } from "./schema.ts";

export const STORAGE_SCOPES = ["metadata", "message_body", "tool_output", "full_diff"] as const;
export type StorageScope = typeof STORAGE_SCOPES[number];
export const DEFAULT_STORAGE_SCOPE: StorageScope = "tool_output";
export const DEFAULT_RETENTION_DAYS = 90;
export const BUSY_TIMEOUT_MS = 30_000;
const WAL_RETRY_INTERVAL_MS = 10;
const DAY_MS = 86_400_000;

export interface LedgerOptions {
  storageScope?: StorageScope;
  redactionRules?: RedactionRules;
}
export type AppendResult = {
  status: "appended" | "duplicate";
  seq: number;
  fact_id: string;
} | {
  status: "conflict";
  seq: number;
  fact_id: string;
  existing_payload_hash: string;
  incoming_payload_hash: string;
};
export interface Ledger {
  append(input: FactInput): AppendResult;
  readSince(seq: number, limit: number): Fact[];
  purgePayloads(before: string): number;
  prunePayloads(retentionDays?: number, now?: Date): number;
  close(): void;
}

export function createFactId(source: FactInput["source"], sourceEventId: string): string {
  // 長さと区切りによる衝突を避け、組を一意に符号化する。
  return hashText(JSON.stringify([source, sourceEventId]));
}
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serializeCanonical(value[key])}`).join(",")}}`;
}

const FIELD_LEVELS: Readonly<Record<string, number>> = {
  body: 1, text: 1, content: 1, task: 1, accept: 1,
  tool_output: 2, output: 2, stdout: 2, stderr: 2, result: 2,
  request: 2, verification: 2, review: 2,
  diff: 3, patch: 3, full_diff: 3,
};
function restrictPayload(value: JsonValue, level: number, toolBody = false): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => restrictPayload(item, level, toolBody));
  const isTool = toolBody || value.type === "tool_result" || value.type === "tool_output" || value.role === "tool";
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    const requiredLevel = isTool && ["body", "text", "content"].includes(key) ? 2 : (FIELD_LEVELS[key] ?? 0);
    if (requiredLevel <= level) {
      // 任意のキーをデータとして扱い、__proto__ も通常のキーとして保存する。
      Object.defineProperty(result, key, {
        value: restrictPayload(child, level, isTool), enumerable: true, writable: true,
      });
    }
  }
  if (value.body_state === "stored" && !("body" in result)) result.body_state = "omitted";
  return result;
}
function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError("時刻は有効な日時で指定してください");
}
function assertInput(input: FactInput): void {
  if (!SOURCES.includes(input.source) || !CONFIDENCES.includes(input.confidence)) {
    throw new TypeError("source または confidence が未対応です");
  }
  const [entity, action] = input.kind.split(".");
  if (!ENTITY_KINDS.some((kind) => kind === entity) || !action || !input.subject.startsWith(`${entity}:`) || input.subject.length === entity.length + 1) {
    throw new TypeError("kind と subject の実体を一致させてください");
  }
  if (!input.source_event_id) throw new TypeError("source_event_id は必須です");
  if (action === "corrected" && !input.supersedes) throw new TypeError("訂正には supersedes が必須です");
  assertTimestamp(input.source_ts);
  if (input.observed_ts !== undefined) assertTimestamp(input.observed_ts);
}

function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + BUSY_TIMEOUT_MS;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      // 初回の WAL 切り替えは busy_timeout でも即座に競合を返すため、ここだけ再試行する。
      const remaining = deadline - performance.now();
      if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5 || remaining <= 0) throw error;
      Atomics.wait(waitBuffer, 0, 0, Math.min(WAL_RETRY_INTERVAL_MS, remaining));
    }
  }
}

export function openLedger(path: string, options: LedgerOptions = {}): Ledger {
  const scope = options.storageScope ?? DEFAULT_STORAGE_SCOPE;
  const level = STORAGE_SCOPES.indexOf(scope);
  if (level < 0) throw new TypeError("保存の範囲が未対応です");
  // 呼び出し元による後からの規則の変更を取り込まない。
  const rules: RedactionRules = {
    ...options.redactionRules,
    patterns: options.redactionRules?.patterns?.map((pattern) => typeof pattern === "string" ? pattern : new RegExp(pattern.source, pattern.flags)),
  };
  if (validateRules(rules).length > 0) throw new TypeError("秘匿の規則が不正です");
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWal(db);
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA secure_delete = ON");
    initializeSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const findExisting = db.prepare("SELECT seq, fact_id, payload_hash FROM facts WHERE source = ? AND source_event_id = ?");
  const insert = db.prepare(`INSERT INTO facts (
    fact_id, source, source_event_id, kind, subject, payload, payload_hash,
    source_ts, observed_ts, schema_version, cursor, confidence, supersedes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare("SELECT * FROM facts WHERE seq > ? ORDER BY seq ASC LIMIT ?");
  const purge = db.prepare("UPDATE facts SET payload = NULL WHERE payload IS NOT NULL AND julianday(observed_ts) < julianday(?)");

  function transact<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return {
    append(input) {
      assertInput(input);
      // JSON 化で toJSON 等を解決してから秘匿する。生の本文は SQLite に渡さない。
      const plainPayload = JSON.parse(JSON.stringify(input.payload)) as JsonValue;
      const redacted = redactValue(plainPayload, rules) as JsonValue;
      // 保存範囲の変更や保持整理の後も、同じ内容の再送を識別できるようにする。
      const payloadHash = hashText(serializeCanonical(redacted));
      // 規則がキー名も伏せる場合でも、保存範囲の判定を迂回させない。
      const payload = serializeCanonical(redactValue(restrictPayload(plainPayload, level), rules) as JsonValue);
      const factId = createFactId(input.source, input.source_event_id);
      const observedTs = input.observed_ts ?? new Date().toISOString();
      return transact<AppendResult>(() => {
        const existing = findExisting.get(input.source, input.source_event_id);
        if (existing) {
          const identity = { seq: Number(existing.seq), fact_id: String(existing.fact_id) };
          return existing.payload_hash === payloadHash
            ? { status: "duplicate", ...identity }
            : { status: "conflict", ...identity, existing_payload_hash: String(existing.payload_hash), incoming_payload_hash: payloadHash };
        }
        const result = insert.run(
          factId, input.source, input.source_event_id, input.kind, input.subject,
          payload, payloadHash, input.source_ts, observedTs, SCHEMA_VERSION,
          input.cursor ?? null, input.confidence, input.supersedes ?? null,
        );
        return { status: "appended", seq: Number(result.lastInsertRowid), fact_id: factId };
      });
    },
    readSince(seq, limit) {
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError("seq と limit は非負の安全な整数で指定してください");
      }
      return read.all(seq, limit).map((row) => ({
        ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)),
      } as Fact));
    },
    purgePayloads(before) {
      assertTimestamp(before);
      return transact(() => Number(purge.run(before).changes));
    },
    prunePayloads(retentionDays = DEFAULT_RETENTION_DAYS, now = new Date()) {
      if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new RangeError("保持期間は非負の日数で指定してください");
      return this.purgePayloads(new Date(now.getTime() - retentionDays * DAY_MS).toISOString());
    },
    close() { db.close(); },
  };
}
