export * from "./facts.ts";
export * from "./ledger.ts";
export * from "./schema.ts";
export * from "./redact.ts";
export * from "./projections/index.ts";
export { PROJECTION_TABLES, type ProjectionState } from "./rebuild.ts";

import type { DatabaseSync } from "node:sqlite";
import { applyIncremental as applyProjectionDelta, rebuild as rebuildProjection, type ProjectionState } from "./rebuild.ts";

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
