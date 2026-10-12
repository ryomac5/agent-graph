import type { DatabaseSync } from "node:sqlite";

const UNIX_EPOCH_JULIAN_DAY = 2440587.5;
const DAY_MS = 86_400_000;
const TIMESTAMP_WINDOW_MS = 2;

export const LATEST_MESSAGE_SQL = `SELECT m.id, m.source_ts, m.source_event_id, julianday(m.source_ts) AS source_time
  FROM api_message_order o JOIN messages m ON m.id = o.message_id
  WHERE o.conversation_id = ? AND o.active = 1 AND o.timestamp >= (
    SELECT timestamp FROM api_message_order WHERE conversation_id = ? AND active = 1
      ORDER BY timestamp DESC LIMIT 1) - ${TIMESTAMP_WINDOW_MS / DAY_MS}
    AND julianday(m.source_ts) IS NOT NULL`;

export const FALLBACK_MESSAGE_SQL = `SELECT m.id, m.source_ts, m.source_event_id, julianday(m.source_ts) AS source_time
  FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
  WHERE mm.conversation_id = ? AND mm.active = 1 AND julianday(m.source_ts) = (
    SELECT max(julianday(m2.source_ts)) FROM message_memberships mm2 JOIN messages m2 ON m2.id = mm2.message_id
      WHERE mm2.conversation_id = ? AND mm2.active = 1)`;

/** 本文を複製せず、所属と発言の変更を同じ取引で時刻索引へ反映する。 */
export function initializeSummaryIndex(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_message_order'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS api_message_order (
    membership_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
    active INTEGER NOT NULL, timestamp REAL);
    CREATE INDEX IF NOT EXISTS api_message_latest ON api_message_order(conversation_id, active, timestamp DESC);
    CREATE INDEX IF NOT EXISTS api_message_reference ON api_message_order(message_id)`);
  if (!exists) db.exec(`INSERT INTO api_message_order (membership_id, conversation_id, message_id, active, timestamp)
    SELECT mm.id, mm.conversation_id, mm.message_id, mm.active,
      coalesce(n.source_time / ${DAY_MS}.0 + ${UNIX_EPOCH_JULIAN_DAY},
        (SELECT julianday(source_ts) FROM messages WHERE id = mm.message_id))
    FROM message_memberships mm LEFT JOIN message_name_inputs n ON n.id = mm.message_id`);
  for (const operation of ["INSERT", "UPDATE"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS api_order_membership_${operation} AFTER ${operation} ON message_memberships
      BEGIN INSERT OR REPLACE INTO api_message_order (membership_id, conversation_id, message_id, active, timestamp)
        SELECT NEW.id, NEW.conversation_id, NEW.message_id, NEW.active, julianday(m.source_ts)
        FROM (SELECT 1) LEFT JOIN messages m ON m.id = NEW.message_id; END;
      CREATE TRIGGER IF NOT EXISTS api_order_message_${operation} AFTER ${operation} ON messages
      BEGIN UPDATE api_message_order SET timestamp = julianday(NEW.source_ts) WHERE message_id = NEW.id; END`);
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS api_order_membership_DELETE AFTER DELETE ON message_memberships
    BEGIN DELETE FROM api_message_order WHERE membership_id = OLD.id; END;
    CREATE TRIGGER IF NOT EXISTS api_order_message_DELETE AFTER DELETE ON messages
    BEGIN UPDATE api_message_order SET timestamp = NULL WHERE message_id = OLD.id; END`);
}
