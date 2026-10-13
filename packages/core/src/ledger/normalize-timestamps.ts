import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { normalizeStoredTimestamp, TIMESTAMP_FIELDS } from './timestamps.ts';
import { createNativeId } from './projections/relations.ts';
import { compareEventOrder } from './event-order.ts';
import { getMessageText } from './projections/messages.ts';

export interface TimestampRepair { changes: Record<string, number>; generation: number; }
export const TIMESTAMP_REPAIR_ID = 'utc-milliseconds-v1';
const REPAIR_BATCH_SIZE = 256;
const CANONICAL_TIMESTAMP = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z';

// 更新で候補から消える行も、不正なまま残る行も、主キーで一度だけ通る。
function* readRepairBatches(db: DatabaseSync, table: string, keys: readonly string[], columns: string, condition: string,
  parameters: SQLInputValue[] = []) {
  const order = keys.join(', ');
  const select = `SELECT ${columns} FROM ${table} WHERE (${condition})`;
  const first = db.prepare(`${select} ORDER BY ${order} LIMIT ${REPAIR_BATCH_SIZE}`);
  const next = db.prepare(`${select} AND (${order}) > (${keys.map(() => '?').join(', ')}) ORDER BY ${order} LIMIT ${REPAIR_BATCH_SIZE}`);
  let rows = first.all(...parameters);
  while (rows.length) {
    yield* rows;
    if (rows.length < REPAIR_BATCH_SIZE) break;
    const last = rows.at(-1)!;
    rows = next.all(...parameters, ...keys.map(key => last[key] as SQLInputValue));
  }
}

function needsRepair(expression: string): string {
  return `${expression} NOT GLOB '${CANONICAL_TIMESTAMP}'`;
}

export function hasNormalizedLedgerTimestamps(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger_repairs'").get()
    && !!db.prepare('SELECT 1 FROM ledger_repairs WHERE id = ?').get(TIMESTAMP_REPAIR_ID);
}

/** 版を変えずに既存の時刻列を補完する。payload と識別子は変更しない。 */
export function normalizeLedgerTimestamps(db: DatabaseSync, options: { once?: boolean } = {}): TimestampRepair {
  const changes: Record<string, number> = {};
  const readGeneration = () => Number(db.prepare('SELECT generation FROM projection_state WHERE id = 1').get()!.generation);
  if (options.once && hasNormalizedLedgerTimestamps(db)) return { changes, generation: readGeneration() };
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
  if (!tables.has('facts') || !tables.has('projection_state')) throw new Error('Ledger required');
  const add = (key: string, count: number | bigint) => { if (count) changes[key] = (changes[key] ?? 0) + Number(count); };
  db.exec('BEGIN IMMEDIATE');
  try {
    // 競合した起動も、書き込みロックを得た後に完了印を再確認する。
    if (options.once && hasNormalizedLedgerTimestamps(db)) {
      const generation = readGeneration();
      db.exec('COMMIT');
      return { changes, generation };
    }
    db.exec(`CREATE TEMP TABLE timestamp_repair_conversations (id TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE timestamp_repair_created (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL) WITHOUT ROWID`);
    const markConversation = tables.has('api_conversation_summaries') ? db.prepare(`INSERT OR IGNORE INTO timestamp_repair_conversations
      SELECT conversation_id FROM message_memberships WHERE message_id = ? AND active = 1`) : undefined;
    for (const table of ['facts', 'conversations', 'runs', 'connections', 'messages', 'approvals', 'search_documents',
      'api_conversation_summaries', 'api_send_watches']) {
      if (!tables.has(table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      const times = columns.map(row => String(row.name)).filter(name => TIMESTAMP_FIELDS.some(field => field === name));
      const keys = columns.filter(row => Number(row.pk) > 0).map(row => String(row.name));
      if (!times.length) continue;
      const update = db.prepare(`UPDATE ${table} SET ${times.map(column => `${column} = ?`).join(', ')}
        WHERE ${keys.map(column => `${column} = ?`).join(' AND ')}`);
      for (const row of readRepairBatches(db, table, keys, [...keys, ...times].join(', '), times.map(needsRepair).join(' OR '))) {
        const values = times.map(column => row[column] === null ? null : normalizeStoredTimestamp(String(row[column])));
        if (times.some((column, index) => row[column] !== values[index])) {
          add(table, update.run(...values, ...keys.map(key => row[key] as SQLInputValue)).changes);
          if (table === 'messages') markConversation?.run(row.id!);
        }
      }
    }
    // JSON の投影も同じ欄だけを補う。body、evidence、constraints などの内部は不変。
    for (const [table, keys] of [['projection_records', ['projection', 'entity_id']], ['entity_records', ['entity', 'id']]] as const) {
      if (!tables.has(table)) continue;
      const condition = `EXISTS (SELECT 1 FROM json_each(data) j WHERE j.type = 'text'
        AND j.key IN (${TIMESTAMP_FIELDS.map(field => `'${field}'`).join(', ')}) AND ${needsRepair('j.value')})
        OR EXISTS (SELECT 1 FROM json_each(data, '$.pending_inputs') j
          WHERE json_type(j.value, '$.source_ts') = 'text' AND ${needsRepair("json_extract(j.value, '$.source_ts')")})`;
      const update = db.prepare(`UPDATE ${table} SET data = json_set(data, ?, ?) WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`);
      // 本文を JS に渡さず、1 レコードの時刻欄だけを取り出す。
      const timestamps = `SELECT '$.' || j.key AS path, j.value AS timestamp FROM ${table} r, json_each(r.data) j
        WHERE ${keys.map(key => `r.${key} = ?`).join(' AND ')} AND j.type = 'text'
        AND j.key IN (${TIMESTAMP_FIELDS.map(field => `'${field}'`).join(', ')}) AND ${needsRepair('j.value')}
        UNION ALL SELECT '$.pending_inputs[' || j.key || '].source_ts', json_extract(j.value, '$.source_ts')
        FROM ${table} r, json_each(r.data, '$.pending_inputs') j
        WHERE ${keys.map(key => `r.${key} = ?`).join(' AND ')} AND json_type(j.value, '$.source_ts') = 'text'
        AND ${needsRepair("json_extract(j.value, '$.source_ts')")}`;
      for (const row of readRepairBatches(db, table, keys, keys.join(', '), condition)) {
        const values = keys.map(key => row[key] as SQLInputValue);
        for (const item of readRepairBatches(db, `(${timestamps})`, ['path'], '*', '1', [...values, ...values])) {
          const timestamp = String(item.timestamp);
          const value = normalizeStoredTimestamp(timestamp);
          if (value !== timestamp) add(table, update.run(item.path!, value, ...values).changes);
        }
      }
    }
    // 旧い文字列の最小値で選んだ作成時刻は、既存値の変換だけでは直らない。
    const created = db.prepare(`INSERT INTO timestamp_repair_created VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET timestamp = min(timestamp, excluded.timestamp)`);
    for (const row of db.prepare(`SELECT substr(subject, 14) AS id, source_ts,
      json_extract(payload, '$.provider') AS provider, json_extract(payload, '$.native_id') AS native_id
      FROM facts WHERE kind = 'conversation.created' AND seq <= (SELECT last_seq FROM projection_state WHERE id = 1)`).iterate()) {
      const id = row.provider && row.native_id ? createNativeId(String(row.provider), String(row.native_id)) : String(row.id);
      const timestamp = String(row.source_ts);
      created.run(id, timestamp);
    }
    const conversation = db.prepare('UPDATE conversations SET created_ts = ? WHERE id = ? AND created_ts IS NOT ?');
    const record = db.prepare(`UPDATE projection_records SET data = json_set(data, '$.created_ts', ?)
      WHERE projection = 'conversations' AND entity_id = ? AND json_extract(data, '$.created_ts') IS NOT ?`);
    for (const { id, timestamp } of db.prepare('SELECT id, timestamp FROM timestamp_repair_created').iterate()) {
      add('conversations.created_ts', conversation.run(timestamp, id, timestamp).changes);
      add('projection_records.created_ts', record.run(timestamp, id, timestamp).changes);
    }
    // 式索引は列の UPDATE が直す。API の補助索引も、trigger がない複製を含めて補う。
    if (tables.has('api_message_order')) add('api_message_order', db.prepare(`UPDATE api_message_order SET timestamp = (
      SELECT julianday(source_ts) FROM messages WHERE id = message_id) WHERE timestamp IS NOT (
      SELECT julianday(source_ts) FROM messages WHERE id = message_id)`).run().changes);
    if (tables.has('api_conversation_summaries')) {
      const latest = db.prepare(`SELECT m.id, m.source_event_id, m.source_ts FROM messages m
        JOIN message_memberships mm ON mm.message_id = m.id WHERE mm.conversation_id = ? AND mm.active = 1
        AND m.source_ts = (SELECT max(m2.source_ts) FROM messages m2 JOIN message_memberships mm2 ON mm2.message_id = m2.id
          WHERE mm2.conversation_id = ? AND mm2.active = 1)`);
      const update = db.prepare(`UPDATE api_conversation_summaries SET last_message_ts = ?, last_message_excerpt = ?
        WHERE id = ? AND (last_message_ts IS NOT ? OR last_message_excerpt IS NOT ?)`);
      for (const row of db.prepare('SELECT id FROM timestamp_repair_conversations').iterate()) {
        let last: ReturnType<typeof latest.get>;
        for (const candidate of latest.iterate(row.id!, row.id!)) {
          if (!last || (compareEventOrder(String(candidate.source_event_id ?? ''), String(last.source_event_id ?? ''))
            || compareEventOrder(String(candidate.id), String(last.id))) > 0) last = candidate;
        }
        const body = last && db.prepare('SELECT body FROM messages WHERE id = ?').get(last.id!)?.body;
        const excerpt = body ? getMessageText(JSON.parse(String(body))).slice(0, 120) : '';
        const timestamp = last?.source_ts ?? null;
        add('api_conversation_summaries.latest', update.run(timestamp, excerpt, row.id!, timestamp, excerpt).changes);
      }
    }
    if (Object.keys(changes).length) db.exec('UPDATE projection_state SET generation = generation + 1 WHERE id = 1');
    // 完了印と補完を一緒に確定する。失敗時は次の起動で再試行できる。
    db.exec('CREATE TABLE IF NOT EXISTS ledger_repairs (id TEXT PRIMARY KEY)');
    db.prepare('INSERT OR IGNORE INTO ledger_repairs (id) VALUES (?)').run(TIMESTAMP_REPAIR_ID);
    db.exec('DROP TABLE timestamp_repair_conversations; DROP TABLE timestamp_repair_created');
    const generation = readGeneration();
    db.exec('COMMIT');
    return { changes, generation };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
