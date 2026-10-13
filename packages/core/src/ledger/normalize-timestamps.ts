import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { normalizeTimestamp, TIMESTAMP_FIELDS } from './timestamps.ts';
import { createNativeId } from './projections/relations.ts';
import { compareEventOrder } from './event-order.ts';
import { getMessageText } from './projections/messages.ts';

export interface TimestampRepair { changes: Record<string, number>; generation: number; }

/** 版を変えずに既存の時刻列を補完する。payload と識別子は変更しない。 */
export function normalizeLedgerTimestamps(db: DatabaseSync): TimestampRepair {
  const changes: Record<string, number> = {};
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
  if (!tables.has('facts') || !tables.has('projection_state')) throw new Error('Ledger required');
  const add = (key: string, count: number | bigint) => { if (count) changes[key] = (changes[key] ?? 0) + Number(count); };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['facts', 'conversations', 'runs', 'connections', 'messages', 'approvals', 'search_documents',
      'api_conversation_summaries', 'api_send_watches']) {
      if (!tables.has(table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all();
      const times = columns.map(row => String(row.name)).filter(name => TIMESTAMP_FIELDS.some(field => field === name));
      const keys = columns.filter(row => Number(row.pk) > 0).map(row => String(row.name));
      if (!times.length) continue;
      const update = db.prepare(`UPDATE ${table} SET ${times.map(column => `${column} = ?`).join(', ')}
        WHERE ${keys.map(column => `${column} = ?`).join(' AND ')}`);
      for (const row of db.prepare(`SELECT ${[...keys, ...times].join(', ')} FROM ${table}`).iterate()) {
        const values = times.map(column => row[column] === null ? null : normalizeTimestamp(String(row[column])));
        if (times.some((column, index) => row[column] !== values[index])) {
          add(table, update.run(...values, ...keys.map(key => row[key] as SQLInputValue)).changes);
        }
      }
    }
    // JSON の投影も同じ欄だけを補う。body、evidence、constraints などの内部は不変。
    for (const [table, keys] of [['projection_records', ['projection', 'entity_id']], ['entity_records', ['entity', 'id']]] as const) {
      if (!tables.has(table)) continue;
      const selectedKeys = keys.map(key => `r.${key}`).join(', ');
      const updates: { keys: SQLInputValue[]; path: string; value: string }[] = [];
      const collect = (sql: string) => {
        for (const row of db.prepare(sql).iterate()) {
          if (typeof row.timestamp !== 'string') continue;
          const value = normalizeTimestamp(row.timestamp);
          if (value !== row.timestamp) updates.push({ keys: keys.map(key => row[key] as SQLInputValue), path: String(row.path), value });
        }
      };
      collect(`SELECT ${selectedKeys}, '$.' || j.key AS path, j.value AS timestamp FROM ${table} r, json_each(r.data) j
        WHERE j.key IN (${TIMESTAMP_FIELDS.map(field => `'${field}'`).join(', ')})`);
      collect(`SELECT ${selectedKeys}, '$.pending_inputs[' || j.key || '].source_ts' AS path,
        json_extract(j.value, '$.source_ts') AS timestamp FROM ${table} r, json_each(r.data, '$.pending_inputs') j`);
      const update = db.prepare(`UPDATE ${table} SET data = json_set(data, ?, ?) WHERE ${keys.map(key => `${key} = ?`).join(' AND ')}`);
      for (const row of updates) add(table, update.run(row.path, row.value, ...row.keys).changes);
    }
    // 旧い文字列の最小値で選んだ作成時刻は、既存値の変換だけでは直らない。
    const created = new Map<string, string>();
    for (const row of db.prepare(`SELECT substr(subject, 14) AS id, source_ts,
      json_extract(payload, '$.provider') AS provider, json_extract(payload, '$.native_id') AS native_id
      FROM facts WHERE kind = 'conversation.created' AND seq <= (SELECT last_seq FROM projection_state WHERE id = 1)`).iterate()) {
      const id = row.provider && row.native_id ? createNativeId(String(row.provider), String(row.native_id)) : String(row.id);
      const timestamp = String(row.source_ts);
      if (!created.has(id) || timestamp < created.get(id)!) created.set(id, timestamp);
    }
    const conversation = db.prepare('UPDATE conversations SET created_ts = ? WHERE id = ? AND created_ts IS NOT ?');
    const record = db.prepare(`UPDATE projection_records SET data = json_set(data, '$.created_ts', ?)
      WHERE projection = 'conversations' AND entity_id = ? AND json_extract(data, '$.created_ts') IS NOT ?`);
    for (const [id, timestamp] of created) {
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
      for (const row of db.prepare('SELECT id FROM api_conversation_summaries').iterate()) {
        const last = latest.all(row.id!, row.id!).sort((a, b) => compareEventOrder(String(a.source_event_id ?? ''), String(b.source_event_id ?? ''))
          || compareEventOrder(String(a.id), String(b.id))).at(-1);
        const body = last && db.prepare('SELECT body FROM messages WHERE id = ?').get(last.id!)?.body;
        const excerpt = body ? getMessageText(JSON.parse(String(body))).slice(0, 120) : '';
        const timestamp = last?.source_ts ?? null;
        add('api_conversation_summaries.latest', update.run(timestamp, excerpt, row.id!, timestamp, excerpt).changes);
      }
    }
    if (Object.keys(changes).length) db.exec('UPDATE projection_state SET generation = generation + 1 WHERE id = 1');
    const generation = Number(db.prepare('SELECT generation FROM projection_state WHERE id = 1').get()!.generation);
    db.exec('COMMIT');
    return { changes, generation };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
