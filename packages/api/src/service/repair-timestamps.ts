import { DatabaseSync } from 'node:sqlite';
import { BUSY_TIMEOUT_MS } from '../../../core/src/ledger/ledger.ts';
import { normalizeLedgerTimestamps } from '../../../core/src/ledger/normalize-timestamps.ts';

// 配信開始後の worker で実行する。台帳の列を更新するため FULL の耐久性を保つ。
export function repairTimestampsOnStartup(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  const started = performance.now();
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA synchronous = FULL`);
    const result = normalizeLedgerTimestamps(db, { once: true });
    return { ...result, elapsed_ms: performance.now() - started };
  } finally { db.close(); }
}
