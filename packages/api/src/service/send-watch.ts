import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { getMessageText } from '../../../core/src/ledger/projections/messages.ts';
import type { JsonValue } from '../../../core/src/ledger/facts.ts';
import { redact, type RedactionRules } from '../../../core/src/ledger/redact.ts';

export const SEND_WATCH_TIMEOUT_MS = 60_000;
export const SEND_WATCH_FAILED_RETENTION_MS = 24 * 60 * 60_000;
export const SEND_WATCH_CLOSED_RETENTION_MS = 7 * SEND_WATCH_FAILED_RETENTION_MS;
export const SEND_WATCH_PENDING_MAX_AGE_MS = 24 * 60 * 60_000;
export const SEND_WATCH_CLEANUP_INTERVAL_MS = 60_000;
const WRITE_RETRY_MS = 10;
const WRITE_RETRY_LIMIT = 500;
const WAITING_QUEUE = -1;
const HISTORY_LIMIT = 100;
const EXCERPT_LENGTH = 120;
const BUSY_STATES = new Set(['starting', 'running', 'waiting_approval', 'waiting_input']);
type WatchRow = Record<string, SQLOutputValue>;

function isBusy(error: unknown): boolean {
  return error instanceof Error && 'errcode' in error && (Number(error.errcode) & 0xff) === 5;
}

function readAttachments(value: SQLOutputValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

export function normalizeSentBody(body: unknown): string {
  const text = getMessageText(body as JsonValue);
  return text.replace(/<\/?pasted_content\b[^>]*>/gu, '').replace(/\[Image #\d+\]/gu, '').trim();
}

/** 台帳の事実と投影から独立した、api の配達確認。 */
export class SendWatch {
  private db: DatabaseSync;
  private dirty = false;
  private stopped = false;
  private queued = new Map<string, Parameters<SendWatch['recordAccepted']>>();
  private lastCleanup: number | undefined;
  constructor(path: string, privateRules: () => RedactionRules = () => ({})) {
    this.rules = privateRules;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS api_send_watches (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL, sent_ts TEXT NOT NULL,
        baseline_seq INTEGER NOT NULL, busy_run TEXT, deadline_ms INTEGER,
        state TEXT NOT NULL, message_id TEXT, closed_ts TEXT, failed_ts TEXT, attachments TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS api_send_watch_pending ON api_send_watches(state);
      CREATE UNIQUE INDEX IF NOT EXISTS api_send_watch_message ON api_send_watches(message_id) WHERE message_id IS NOT NULL;`);
    this.db.exec("PRAGMA busy_timeout = 0");
  }
  private rules: () => RedactionRules;
  private canonical(id: string): string {
    return String(this.db.prepare('SELECT canonical_id FROM api_conversation_ids WHERE id = ?').get(id)?.canonical_id ?? id);
  }
  capture(conversation: string, now = Date.now()) {
    const id = this.canonical(conversation);
    const run = this.db.prepare(`SELECT id, state FROM runs WHERE conversation_id = ? OR conversation_id IN
      (SELECT id FROM api_conversation_ids WHERE canonical_id = ?) ORDER BY generation DESC LIMIT 1`).get(id, id);
    return { sent_ts: new Date(now).toISOString(), baseline_seq: Number(this.db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM facts').get()!.seq),
      busy_run: run && BUSY_STATES.has(String(run.state)) ? String(run.id) : null };
  }
  record(id: string, conversation: string, body: string, captured: ReturnType<SendWatch['capture']>, attachments: string[] = []) {
    if (body.trimStart().startsWith('/')) return;
    this.db.prepare('INSERT OR IGNORE INTO api_send_watches VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)')
      .run(id, conversation, redact(body, this.rules()).text, captured.sent_ts, captured.baseline_seq, captured.busy_run,
        captured.busy_run ? null : Date.parse(captured.sent_ts) + SEND_WATCH_TIMEOUT_MS, 'pending', JSON.stringify(attachments));
  }
  async recordAccepted(id: string, conversation: string, body: string, captured: ReturnType<SendWatch['capture']>, attachments: string[] = [], retryOf?: string) {
    // 貼り付けが終わった時刻を起点にし、照合の seq は送信前の値を保つ。
    const accepted = { ...captured, sent_ts: new Date(Date.now()).toISOString() };
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return;
      try {
        this.record(id, conversation, body, accepted, attachments);
        if (retryOf) this.retry(retryOf, conversation);
        return;
      } catch (error) {
        if (!isBusy(error) || attempt >= WRITE_RETRY_LIMIT) {
          this.queued.set(id, [id, conversation, body, accepted, attachments, retryOf]);
          console.error('Send watch recording failed:', { id, conversation_id: conversation, retry: 'next check; memory queue is lost on API restart' }, error);
          return;
        }
        // runner の書き込み待ちは主スレッドを塞がずに再試行する。
        await delay(WRITE_RETRY_MS);
      }
    }
  }
  history(conversation: string) {
    return this.db.prepare('SELECT * FROM api_send_watches WHERE conversation_id = ? ORDER BY sent_ts DESC LIMIT ?').all(conversation, HISTORY_LIMIT);
  }
  retry(id: string, conversation: string, now = Date.now()) {
    const result = this.db.prepare("UPDATE api_send_watches SET state = 'retried', closed_ts = ? WHERE id = ? AND conversation_id = ? AND state = 'failed'")
      .run(new Date(now).toISOString(), id, conversation);
    if (result.changes) this.dirty = true;
  }
  list(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM api_send_watches WHERE state IN ('pending', 'failed') ORDER BY sent_ts, id").all()
      .map(row => ({ ...row, conversation_id: this.canonical(String(row.conversation_id)), attachments: readAttachments(row.attachments) }));
  }
  check(now = Date.now()): boolean {
    try { return this.checkRows(now); }
    catch (error) {
      // 観測ワーカーの書き込み中は、未配信の変更も含めて次の周期へ回す。
      if (isBusy(error)) return false;
      throw error;
    }
  }
  private checkRows(now: number): boolean {
    for (const [id, args] of this.queued) {
      try {
        const [watchId, conversation, body, captured, attachments, retryOf] = args;
        this.record(watchId, conversation, body, captured, attachments);
        if (retryOf) this.retry(retryOf, conversation, now);
        this.queued.delete(id);
        this.dirty = true;
      } catch (error) {
        if (!isBusy(error)) console.error('Send watch recording retry failed:', { id }, error);
      }
    }
    const rows = this.db.prepare("SELECT * FROM api_send_watches WHERE state IN ('pending', 'failed') ORDER BY sent_ts, rowid").all();
    for (const watch of rows) {
      try { this.checkRow(watch, now); }
      catch (error) {
        if (isBusy(error)) continue;
        // 壊れた行の失敗保存も、後続の見張りを止めない。
        try { this.fail(watch, now, 'watch evaluation failed'); }
        catch (failure) { console.error('Send watch failure recording failed:', { id: watch.id }, failure); }
      }
    }
    if (this.lastCleanup === undefined || now - this.lastCleanup >= SEND_WATCH_CLEANUP_INTERVAL_MS) {
      this.lastCleanup = now;
      try {
        const removed = this.db.prepare(`DELETE FROM api_send_watches WHERE
          (state = 'failed' AND failed_ts <= ?) OR
          (state IN ('closed', 'retried') AND coalesce(closed_ts, failed_ts, sent_ts) <= ?) OR
          ltrim(body) LIKE '/%'`).run(new Date(now - SEND_WATCH_FAILED_RETENTION_MS).toISOString(),
            new Date(now - SEND_WATCH_CLOSED_RETENTION_MS).toISOString());
        if (removed.changes) this.dirty = true;
      } catch (error) {
        if (!isBusy(error)) console.error('Send watch cleanup failed:', error);
      }
    }
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }
  private fail(watch: WatchRow, now: number, reason: string) {
    if (watch.state !== 'pending') return;
    const result = this.db.prepare("UPDATE api_send_watches SET state = 'failed', failed_ts = ? WHERE id = ? AND state = 'pending'")
      .run(new Date(now).toISOString(), watch.id!);
    if (!result.changes) return;
    this.dirty = true;
    console.error(`Message delivery failed: ${JSON.stringify({ id: watch.id, conversation_id: watch.conversation_id, reason, excerpt: String(watch.body).slice(0, EXCERPT_LENGTH) })}`);
  }
  private checkRow(watch: WatchRow, now: number) {
    if (String(watch.body).trimStart().startsWith('/')) return;
    const conversation = this.canonical(String(watch.conversation_id));
    const expected = normalizeSentBody(watch.body);
    // seq で過去の同文を除き、所属と利用者の役割の両方を確かめる。
    const candidates = this.db.prepare(`WITH recent AS MATERIALIZED (
      SELECT seq, CASE WHEN json_extract(payload, '$.provider') IS NOT NULL AND json_extract(payload, '$.native_id') IS NOT NULL
        THEN json_array(json_extract(payload, '$.provider'), json_extract(payload, '$.native_id')) ELSE substr(subject, 9) END AS message_id
      FROM facts WHERE seq > ? AND kind = 'message.created')
      SELECT m.id, m.body FROM recent JOIN messages m ON m.id = recent.message_id
      JOIN message_memberships mm ON mm.message_id = m.id AND mm.conversation_id = ? AND mm.active = 1
      WHERE m.role = 'user' AND NOT EXISTS (SELECT 1 FROM api_send_watches w WHERE w.message_id = m.id)
      ORDER BY recent.seq`)
      .iterate(watch.baseline_seq!, conversation);
    let matched: string | undefined;
    for (const candidate of candidates) {
      const body = JSON.parse(String(candidate.body ?? 'null'));
      if (!expected && JSON.parse(String(watch.attachments)).length && !(Array.isArray(body) && body.some(block => block?.type === 'image'))) continue;
      if (normalizeSentBody(body) === expected) { matched = String(candidate.id); break; }
    }
    if (matched) {
      this.db.prepare("UPDATE api_send_watches SET state = 'closed', message_id = ?, closed_ts = ? WHERE id = ?")
        .run(matched, new Date(now).toISOString(), watch.id!);
      this.dirty = true;
      return;
    }
    if (watch.state === 'failed') return;
    if (now - Date.parse(String(watch.sent_ts)) >= SEND_WATCH_PENDING_MAX_AGE_MS) {
      this.fail(watch, now, 'pending age limit exceeded');
      return;
    }
    const record = this.db.prepare("SELECT data FROM projection_records WHERE projection = 'conversations' AND entity_id = ?").get(conversation);
    const queue = record ? JSON.parse(String(record.data)).pending_inputs ?? [] : [];
    if (queue.some((input: { body: unknown; delivery_id?: string }) => input.delivery_id === watch.id || normalizeSentBody(input.body) === expected)) {
      if (watch.deadline_ms !== WAITING_QUEUE) {
        this.db.prepare('UPDATE api_send_watches SET deadline_ms = ? WHERE id = ?').run(WAITING_QUEUE, watch.id!);
      }
      return;
    }
    let deadline = watch.deadline_ms === null || watch.deadline_ms === WAITING_QUEUE ? undefined : Number(watch.deadline_ms);
    if (deadline === undefined) {
      if (watch.busy_run) {
        const boundary = this.db.prepare(`SELECT f.observed_ts FROM facts f WHERE f.seq > ? AND f.kind IN ('run.state_changed', 'run.ended')
          AND (f.subject = 'run:' || ? OR f.subject IN (SELECT 'run:' || subject_id FROM run_subjects
            WHERE conversation_id = ? OR conversation_id IN (SELECT id FROM api_conversation_ids WHERE canonical_id = ?)))
          AND (json_extract(f.payload, '$.state') IN ('idle', 'ended', 'failed') OR f.kind = 'run.ended') ORDER BY f.seq LIMIT 1`)
          .get(watch.baseline_seq!, watch.busy_run, conversation, conversation);
        if (!boundary) return;
        deadline = Math.max(Date.parse(String(boundary.observed_ts)), Date.parse(String(watch.sent_ts))) + SEND_WATCH_TIMEOUT_MS;
        if (watch.deadline_ms === WAITING_QUEUE) deadline = Math.max(deadline, now + SEND_WATCH_TIMEOUT_MS);
      } else deadline = now + SEND_WATCH_TIMEOUT_MS;
      this.db.prepare('UPDATE api_send_watches SET deadline_ms = ? WHERE id = ?').run(deadline, watch.id!);
    }
    if (now < deadline) return;
    this.fail(watch, now, 'delivery timeout');
  }
  close() { this.stopped = true; this.queued.clear(); this.db.close(); }
}
