import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) throw new Error('Usage: node scripts/audit-ledger-timestamps.ts <database>');
const db = new DatabaseSync(path, { readOnly: true });
db.exec('PRAGMA query_only = ON; BEGIN');
db.function('timestamp_format', { deterministic: true }, value => {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return 'numeric';
  const text = String(value);
  const zone = /(?:Z|[+-]\d{2}:?\d{2})$/.exec(text)?.[0] ?? 'no-zone';
  const digits = /\.(\d+)/.exec(text)?.[1].length ?? 0;
  return `${zone};fraction=${digits}${Number.isFinite(Date.parse(text)) ? '' : ';invalid'}`;
});
try {
  const columns = [];
  const tablesWithoutTimestampColumns: string[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const table = String(name);
    const start = columns.length;
    for (const column of db.prepare(`PRAGMA table_info("${table}")`).all()) {
      if (!/(?:_ts|_time|timestamp|_ms)$/.test(String(column.name))) continue;
      const key = String(column.name);
      columns.push({ table, column: key, counts: db.prepare(`SELECT timestamp_format("${key}") AS format,
        count(*) AS count, sum(typeof("${key}") = 'text' AND julianday("${key}") IS NULL) AS julianday_null
        FROM "${table}" GROUP BY format ORDER BY format`).all() });
    }
    if (columns.length === start) tablesWithoutTimestampColumns.push(table);
  }
  const sources = db.prepare(`SELECT source, timestamp_format(source_ts) AS format, count(*) AS count,
    sum(julianday(source_ts) IS NULL) AS julianday_null FROM facts GROUP BY source, format ORDER BY source, format`).all();
  const payloads = db.prepare(`SELECT source, j.key AS field, timestamp_format(j.value) AS format, count(*) AS count
    FROM facts, json_each(payload) j WHERE j.key GLOB '*_ts'
    GROUP BY source, field, format ORDER BY source, field, format`).all();
  const records = [];
  for (const [table, entity] of [['projection_records', 'projection'], ['entity_records', 'entity']]) {
    records.push({ table, counts: db.prepare(`SELECT ${entity}, j.key AS field, timestamp_format(j.value) AS format, count(*) AS count
      FROM ${table}, json_each(data) j WHERE j.key GLOB '*_ts' GROUP BY ${entity}, field, format ORDER BY ${entity}, field, format`).all() });
    records.push({ table: `${table}.pending_inputs`, counts: db.prepare(`SELECT ${entity}, 'source_ts' AS field,
      timestamp_format(json_extract(j.value, '$.source_ts')) AS format, count(*) AS count
      FROM ${table}, json_each(data, '$.pending_inputs') j GROUP BY ${entity}, format ORDER BY ${entity}, format`).all() });
  }
  console.log(JSON.stringify({ captured_at: new Date().toISOString(), max_seq: db.prepare('SELECT max(seq) AS seq FROM facts').get()?.seq,
    columns, sources, payloads, records, tables_without_timestamp_columns: tablesWithoutTimestampColumns }, null, 2));
} finally { db.exec('ROLLBACK'); db.close(); }
