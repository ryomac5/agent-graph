import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { evaluateDelivery, normalizeShellInput } from '../../../core/src/state/index.ts';
import { SESSION_SCAN_VALID_MS, type SessionScan } from './session-scan.ts';
import type { DeliveryDecision, DeliveryEvidence, Operation, Receipt } from '../../../core/src/state/index.ts';
import { getMessageText } from '../../../core/src/ledger/projections/messages.ts';
import type { JsonValue } from '../../../core/src/ledger/facts.ts';
import { redact, type RedactionRules } from '../../../core/src/ledger/redact.ts';

export const SEND_WATCH_TIMEOUT_MS = 60_000;
const BODY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const HISTORY_LIMIT = 100;
type Row = Record<string, unknown>;
export function normalizeSentBody(body: unknown): string {
  const text = getMessageText(body as JsonValue);
  const command = /<command-name>([^<]+)<\/command-name>/u.exec(text)?.[1];
  if (command) return `${command} ${/<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1] ?? ''}`.trim();
  return normalizeShellInput(text.replace(/<\/?pasted_content\b[^>]*>/gu, '').replace(/\[Image #\d+\]/gu, ''));
}
const bodyKey = (body: unknown) => createHash('sha256').update(normalizeSentBody(body)).digest('hex');

/** 送出の事実を保持し、配達の意味は evaluateDelivery に委ねる。 */
export class SendWatch {
  private db: DatabaseSync;
  private decisions = new Map<string, DeliveryDecision>();
  private dirty = true;
  private seq = -1;
  private dataVersion = -1;
  private evaluatedAt = 0;
  private reevaluateAt = 0;
  private messages = new Map<string, string>();
  private queues = new Map<string, string>();
  private rules: () => RedactionRules;
  constructor(path: string, rules: () => RedactionRules = () => ({})) {
    this.rules = rules;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 0;
      CREATE TABLE IF NOT EXISTS api_delivery_operations (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_delivery_evidence (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    const legacy = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_send_watches'").get();
    if (legacy) for (const row of this.db.prepare('SELECT * FROM api_send_watches').all()) {
      const id = String(row.id);
      if (this.has(id)) continue;
      const captured = this.capture(String(row.conversation_id), Date.parse(String(row.sent_ts)));
      this.begin(id, String(row.conversation_id), String(row.body), captured, JSON.parse(String(row.attachments ?? '[]')));
      this.phase(id, row.state === 'closed' ? 'legacy_closed' : 'legacy_failed', Date.parse(String(row.sent_ts)));
    }
    // 再起動で残った送出は再実行しない。候補や相関は引き続き再評価する。
    for (const row of this.rows().filter(row => !row.archived)) this.phase(String(row.id), 'owner_lost');
    this.check();
  }
  private canonical(id: string): string {
    return String(this.db.prepare('SELECT canonical_id FROM api_conversation_ids WHERE id = ?').get(id)?.canonical_id ?? id);
  }
  capture(conversation: string, now = Date.now(), terminal = 'unresolved', requestedRun?: string) {
    const id = this.canonical(conversation);
    const run = requestedRun === undefined ? this.db.prepare(`SELECT id FROM runs WHERE conversation_id = ? OR conversation_id IN
      (SELECT id FROM api_conversation_ids WHERE canonical_id = ?) ORDER BY started_ts DESC, generation DESC LIMIT 1`).get(id, id)
      : this.db.prepare(`SELECT r.id FROM runs r LEFT JOIN run_subjects s ON s.conversation_id = r.conversation_id AND s.generation = r.generation
        WHERE r.id = ? OR s.subject_id = ? ORDER BY r.started_ts DESC, r.generation DESC LIMIT 1`).get(requestedRun, requestedRun);
    return { sent_ts: new Date(now).toISOString(), baseline_seq: Number(this.db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM facts').get()!.seq),
      target: JSON.stringify([id, run?.id ?? requestedRun ?? null, terminal]) };
  }
  decision(id: string): DeliveryDecision | undefined { return this.decisions.get(id); }
  has(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM api_delivery_operations WHERE id = ?').get(id); }
  begin(id: string, conversation: string, body: string, captured: ReturnType<SendWatch['capture']>, attachments: string[] = []): boolean {
    const data = { ...captured, sent_ts: new Date(captured.sent_ts).toISOString(), body: redact(body, this.rules()).text, body_hash: bodyKey(redact(body, this.rules()).text), attachments, attachments_hash: bodyKey(JSON.stringify(attachments)) };
    const existing = this.db.prepare('SELECT conversation_id, data FROM api_delivery_operations WHERE id = ?').get(id);
    if (existing) {
      const previous = JSON.parse(String(existing.data));
      if (existing.conversation_id !== this.canonical(conversation) || previous.target !== data.target || (previous.body_hash ?? bodyKey(previous.body)) !== data.body_hash || (previous.attachments_hash ?? bodyKey(JSON.stringify(previous.attachments))) !== data.attachments_hash) {
        this.add({ kind: 'operation', id: id + ':conflict:' + bodyKey(JSON.stringify([data.body, attachments])), cmdId: id,
          target: captured.target, bodyKey: bodyKey(JSON.stringify([data.body, attachments])), phase: 'accepted', at: Date.parse(data.sent_ts), observedAt: Date.parse(data.sent_ts) });
      }
      return false;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO api_delivery_operations VALUES (?, ?, ?)').run(id, this.canonical(conversation), JSON.stringify(data));
      this.add({ kind: 'operation', id: `${id}:accepted`, cmdId: id, target: captured.target, bodyKey: bodyKey(data.body),
        at: Date.parse(captured.sent_ts), observedAt: Date.parse(captured.sent_ts), phase: 'accepted' });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return true;
  }
  phase(id: string, phase: Operation['phase'], now = Date.now()): void {
    const row = this.db.prepare('SELECT data FROM api_delivery_operations WHERE id = ?').get(id);
    if (!row) return;
    const data = JSON.parse(String(row.data));
    this.add({ kind: 'operation', id: `${id}:${phase}`, cmdId: id, target: data.target, bodyKey: data.body_hash ?? bodyKey(data.body), phase, at: now, observedAt: now });
  }
  handled(id: string, now = Date.now()): void {
    const row = this.rows().find(row => row.id === id);
    if (row) this.add({ kind: 'terminal', id: `${id}:terminal`, cmdId: id, target: String(row.target), at: now, observedAt: now });
  }
  add(evidence: DeliveryEvidence): void {
    this.db.prepare('INSERT OR IGNORE INTO api_delivery_evidence VALUES (?, ?)').run(evidence.id, JSON.stringify(evidence));
    this.dirty = true;
  }
  record(id: string, conversation: string, body: string, captured: ReturnType<SendWatch['capture']>, attachments: string[] = []): void {
    if (!this.begin(id, conversation, body, captured, attachments)) return;
    this.phase(id, 'emitting', Date.parse(captured.sent_ts));
    this.phase(id, 'emitted', Date.parse(captured.sent_ts));
  }
  private rows(): Row[] {
    return this.db.prepare('SELECT * FROM api_delivery_operations ORDER BY rowid').all().map(row => ({ id: row.id, conversation_id: row.conversation_id, ...JSON.parse(String(row.data)) }));
  }
  history(conversation: string): Row[] { return this.list().filter(row => row.conversation_id === this.canonical(conversation)).slice(-HISTORY_LIMIT).reverse(); }
  list(): Row[] {
    return this.rows().filter(row => !row.archived).map(row => ({ ...row, message_id: this.messages.get(String(row.id)), queue_id: this.queues.get(String(row.id)), decision: this.decisions.get(String(row.id)), state: this.decisions.get(String(row.id))?.value ?? 'accepted' }));
  }
  check(now = Date.now()): boolean {
    const seq = Number(this.db.prepare('SELECT coalesce(max(seq), 0) AS seq FROM facts').get()!.seq);
    const dataVersion = Number(this.db.prepare('PRAGMA data_version').get()!.data_version);
    if (!this.dirty && seq === this.seq && dataVersion === this.dataVersion && now >= this.evaluatedAt && now < this.reevaluateAt) return false;
    this.seq = seq; this.dataVersion = dataVersion; this.evaluatedAt = now; this.reevaluateAt = Infinity;
    const rows = this.rows();
    const evidence = this.db.prepare('SELECT data FROM api_delivery_evidence').all().map(row => JSON.parse(String(row.data)) as DeliveryEvidence);
    for (const item of evidence) if (item.kind === 'scan' && item.at + item.validForMs > now) this.reevaluateAt = Math.min(this.reevaluateAt, item.at + item.validForMs);
    const receipts = new Map<string, Receipt>();
    const receiptMessages = new Map<string, string>();
    const queuedMessages = new Map<string, string>();
    for (const row of this.db.prepare(`SELECT payload FROM facts WHERE kind = 'run.updated' AND json_extract(payload, '$.last_evidence.native_record.attachment.type') = 'queued_command'`).all()) {
      const native = JSON.parse(String(row.payload)).last_evidence.native_record;
      if (native.attachment.delivery_id && native.uuid) queuedMessages.set(JSON.stringify(['claude', native.uuid]), native.attachment.delivery_id);
    }
    for (const watch of rows.filter(row => !row.archived)) {
      const conversation = this.canonical(String(watch.conversation_id));
      for (const row of this.db.prepare(`SELECT m.id, m.body, m.source_ts, f.observed_ts, f.seq FROM messages m
        JOIN message_memberships mm ON mm.message_id = m.id AND mm.conversation_id = ? AND mm.active = 1
        JOIN facts f ON f.kind = 'message.created' AND (f.subject = 'message:' || m.id OR
          json_array(json_extract(f.payload, '$.provider'), json_extract(f.payload, '$.native_id')) = m.id)
        WHERE m.role = 'user' AND f.seq > ?`).iterate(conversation, Number(watch.baseline_seq))) {
        const id = `receipt:${watch.target}:${row.id}`;
        receipts.set(id, { kind: 'receipt', id, target: String(watch.target), inputId: queuedMessages.get(String(row.id)) ?? String(row.id), bodyKey: bodyKey(JSON.parse(String(row.body ?? 'null'))),
          phase: 'consumed', at: Date.parse(String(row.source_ts)), observedAt: Date.parse(String(row.observed_ts)) });
        receiptMessages.set(id, String(row.id));
      }
      for (const row of this.db.prepare(`SELECT fact_id, source_event_id, source_ts, observed_ts, payload FROM facts WHERE kind = 'conversation.input_queue_changed'
        AND subject IN ('conversation:' || ?, 'conversation:' || ?) AND seq > ?`).iterate(conversation, String(watch.conversation_id), Number(watch.baseline_seq))) {
        const input = JSON.parse(String(row.payload)).input_queue_event;
        if (input?.operation !== 'enqueue') continue;
        const id = `queue:${watch.target}:${row.fact_id}`;
        receipts.set(id, { kind: 'receipt', id, target: String(watch.target), inputId: input.delivery_id ?? String(row.source_event_id), bodyKey: bodyKey(input.body),
          phase: 'queued', at: Date.parse(String(row.source_ts)), observedAt: Date.parse(String(row.observed_ts)) });
        receiptMessages.set(id, String(row.source_event_id));
      }
    }
    // 端末が異なる同文操作も一つの照合集合に入れる。対象の版を失わないため受信には候補の対象を列挙する。
    evidence.push(...receipts.values());
    this.messages.clear(); this.queues.clear();
    let changed = this.dirty;
    for (const row of rows) {
      const decision = evaluateDelivery({ cmdId: String(row.id), evidence }, now);
      if (decision.validUntil !== null && decision.validUntil > now) this.reevaluateAt = Math.min(this.reevaluateAt, decision.validUntil);
      const previous = this.decisions.get(String(row.id));
      if (JSON.stringify({ ...previous, evaluatedAt: 0 }) !== JSON.stringify({ ...decision, evaluatedAt: 0 })) changed = true;
      this.decisions.set(String(row.id), decision);
      if (['received', 'received_candidate'].includes(decision.value)) {
        const ids = new Set([...receipts.values()].filter(r => r.phase === 'consumed' && decision.evidenceIds.includes(r.id)).map(r => receiptMessages.get(r.id) ?? r.inputId));
        const queued = [...receipts.values()].filter(r => r.phase === 'queued' && decision.evidenceIds.includes(r.id));
        if (!ids.size && queued.length === 1) this.queues.set(String(row.id), receiptMessages.get(queued[0].id)!);
        if (ids.size === 1) this.messages.set(String(row.id), [...ids][0]);
      }
      if (!row.archived && now >= Date.parse(String(row.sent_ts)) + BODY_RETENTION_MS) {
        const { id, conversation_id, body, attachments, ...metadata } = row;
        this.db.prepare('UPDATE api_delivery_operations SET data = ? WHERE id = ?').run(JSON.stringify({ ...metadata, archived: true, final_decision: decision }), String(id));
        changed = true;
      }
      if (!row.archived && Date.parse(String(row.sent_ts)) + BODY_RETENTION_MS > now) this.reevaluateAt = Math.min(this.reevaluateAt, Date.parse(String(row.sent_ts)) + BODY_RETENTION_MS);
    }
    this.dirty = false;
    return changed;
  }
  recordScan(scan: SessionScan): void {
    const targets = this.rows().filter(row => {
      const conversation = this.db.prepare('SELECT provider FROM conversations WHERE id = ?').get(String(row.conversation_id));
      return !row.archived && conversation?.provider === (scan.provider ?? 'claude');
    }).map(row => String(row.target));
    if (targets.length) this.add({ kind: 'scan', id: scan.id + ':delivery', at: scan.at, observedAt: scan.at,
      source: (scan.provider ?? 'claude') + '_sessions', scope: 'local', subjects: targets, status: scan.status, validForMs: SESSION_SCAN_VALID_MS });
  }
  close(): void { this.db.close(); }
}
