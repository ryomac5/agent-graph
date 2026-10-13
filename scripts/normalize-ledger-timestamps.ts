import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { normalizeLedgerTimestamps } from '../packages/core/src/ledger/normalize-timestamps.ts';

const [path, apply] = process.argv.slice(2);
if (!path || apply !== '--apply') throw new Error('Usage: node scripts/normalize-ledger-timestamps.ts <database> --apply');
if (!statSync(path).isFile()) throw new Error('Existing ledger file required');
const db = new DatabaseSync(path, { readOnly: false });
try {
  db.exec('PRAGMA busy_timeout = 30000');
  const started = performance.now();
  const result = normalizeLedgerTimestamps(db);
  console.log(JSON.stringify({ ...result, elapsed_ms: Math.round(performance.now() - started) }));
} finally { db.close(); }
