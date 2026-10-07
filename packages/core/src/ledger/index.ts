import { DatabaseSync as QueryDatabase } from "node:sqlite";
import { openLedger as openBaseLedger, type LedgerOptions, type Ledger, BUSY_TIMEOUT_MS, DEFAULT_RETENTION_DAYS } from "./ledger.ts";
import { initializeSchema } from "./schema.ts";
import { collectProjectionDependencies } from "./projections/dependencies.ts";
import { registerLedgerDatabase } from "./repository.ts";
export * from "./facts.ts";
export * from "./ledger.ts";
export * from "./schema.ts";
export * from "./redact.ts";
export * from "./turns.ts";
export * from "./projections/index.ts";
export { PROJECTION_TABLES, type ProjectionState } from "./rebuild.ts";

import type { DatabaseSync } from "node:sqlite";
import { applyIncremental as applyProjectionDelta, rebuild as rebuildProjection, rebuildInitialProjection as rebuildInitial, type ProjectionState } from "./rebuild.ts";

const DAY_MS = 86_400_000;
const PROJECTION_CACHE_KIB = 64 * 1024;
const configuredConnections = new WeakSet<DatabaseSync>();

function updateDerivedProjection(database: DatabaseSync, update: () => ProjectionState): ProjectionState {
  if (!configuredConnections.has(database)) {
    const cacheSize = Number(database.prepare("PRAGMA cache_size").get()!.cache_size);
    const pageSize = Number(database.prepare("PRAGMA page_size").get()!.page_size);
    const cacheKib = cacheSize < 0 ? -cacheSize : cacheSize * pageSize / 1024;
    // 小さいページキャッシュによる索引の再読込と変更ページの早期書き出しを防ぐ。
    if (cacheKib < PROJECTION_CACHE_KIB) database.exec(`PRAGMA cache_size = -${PROJECTION_CACHE_KIB}`);
    configuredConnections.add(database);
  }
  const synchronous = Number(database.prepare("PRAGMA synchronous").get()!.synchronous);
  const checkpoint = Number(database.prepare("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint);
  // 再構築できる投影は毎回同期しない。耐久性とチェックポイントは台帳の書き手が担う。
  database.exec("PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0");
  try {
    return update();
  } finally {
    database.exec(`PRAGMA synchronous = ${synchronous}; PRAGMA wal_autocheckpoint = ${checkpoint}`);
  }
}

export function applyIncremental(database: DatabaseSync, sinceSeq: number): ProjectionState {
  return updateDerivedProjection(database, () => applyProjectionDelta(database, sinceSeq));
}

export function rebuild(database: DatabaseSync): ProjectionState {
  return updateDerivedProjection(database, () => rebuildProjection(database));
}


export function rebuildInitialProjection(database: DatabaseSync): ProjectionState {
  return updateDerivedProjection(database, () => rebuildInitial(database));
}

/** 問い合わせ用接続を持つ台帳。事実の書き込みと秘匿は従来の口に委ねる。 */
export function openLedger(path: string, options: LedgerOptions = {}): Ledger {
  const base = openBaseLedger(path, options);
  const database = new QueryDatabase(path);
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA cache_size = -${PROJECTION_CACHE_KIB}`);
  if (path === ":memory:") initializeSchema(database);
  const insertMirror = path === ":memory:" ? database.prepare(`INSERT INTO facts(seq, fact_id, source, source_event_id, kind, subject, payload, payload_hash,
    source_ts, observed_ts, schema_version, cursor, confidence, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) : undefined;
  const insertMirrorDependency = path === ":memory:" ? database.prepare("INSERT OR IGNORE INTO fact_projection_dependencies VALUES (?, ?, ?, ?, ?)") : undefined;
  const ledger: Ledger = {
    ...base,
    append(input) {
      const result = base.append(input);
      // メモリ台帳だけは別接続と共有できないため、秘匿済みの保存内容を同期する。
      if (path === ":memory:" && result.status === "appended") {
        const fact = base.readSince(result.seq - 1, 1)[0];
        insertMirror!.run(fact.seq, fact.fact_id, fact.source, fact.source_event_id, fact.kind, fact.subject,
            fact.payload === null ? null : JSON.stringify(fact.payload), fact.payload_hash, fact.source_ts, fact.observed_ts, fact.schema_version,
            fact.cursor ?? null, fact.confidence, fact.supersedes ?? null);
        for (const dependency of collectProjectionDependencies(fact)) insertMirrorDependency!.run(dependency.projection, fact.subject, dependency.direction, dependency.key, fact.seq);
      }
      return result;
    },
    purgePayloads(before) {
      const count = base.purgePayloads(before);
      if (path === ":memory:") database.prepare("UPDATE facts SET payload = NULL WHERE payload IS NOT NULL AND julianday(observed_ts) < julianday(?)").run(before);
      return count;
    },
    prunePayloads(retentionDays = DEFAULT_RETENTION_DAYS, now = new Date()) {
      if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new RangeError("保持期間は非負の日数で指定してください");
      return ledger.purgePayloads(new Date(now.getTime() - retentionDays * DAY_MS).toISOString());
    },
    close() { database.close(); base.close(); },
  };
  registerLedgerDatabase(ledger, database);
  return ledger;
}
export { readLedgerDatabase } from "./repository.ts";
