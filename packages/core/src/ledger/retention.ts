import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Fact, JsonValue } from './facts.ts';
import { DEFAULT_RETENTION_DAYS, STORAGE_SCOPES, type StorageScope } from './ledger.ts';
import { redact, redactValue, validateRules, type RedactionRules } from './redact.ts';
import { rebuild } from './rebuild.ts';
import { collectProjectionDependencies } from './projections/dependencies.ts';

const DAY_MS = 86_400_000;
const FIELD_LEVELS: Readonly<Record<string, number>> = {
  body: 1, text: 1, content: 1, task: 1, accept: 1,
  tool_output: 2, output: 2, stdout: 2, stderr: 2, result: 2,
  request: 2, verification: 2, review: 2, diff: 3, patch: 3, full_diff: 3,
};
export type MaintenanceOperation =
  | { kind: 'retention'; retentionDays?: number; now?: string }
  | { kind: 'scope'; scope: StorageScope }
  | { kind: 'rescan'; rules: RedactionRules };
export interface PayloadChange { fact_id: string; before: string; after: string | null }
export interface MaintenancePlan { operation: MaintenanceOperation; changes: PayloadChange[]; fingerprint: string }

function fingerprintFacts(db: DatabaseSync): string {
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT fact_id, payload, observed_ts FROM facts ORDER BY seq').iterate()) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

export function restrictStoredPayload(value: JsonValue, scope: StorageScope, toolBody = false): JsonValue {
  const level = STORAGE_SCOPES.indexOf(scope);
  if (level < 0) throw new TypeError('Invalid storage scope');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => restrictStoredPayload(item, scope, toolBody));
  const tool = toolBody || value.type === 'tool_result' || value.type === 'tool_output' || value.role === 'tool';
  const entries = Object.entries(value).filter(([key]) =>
    (tool && ['body', 'text', 'content'].includes(key) ? 2 : FIELD_LEVELS[key] ?? 0) <= level);
  const result = Object.fromEntries(entries.map(([key, child]) => [key, restrictStoredPayload(child, scope, tool)]));
  if (value.body_state === 'stored' && !('body' in result)) result.body_state = 'omitted';
  return result;
}

export function planMaintenance(db: DatabaseSync, operation: MaintenanceOperation): MaintenancePlan {
  if (!operation || typeof operation !== 'object') throw new TypeError('Invalid maintenance operation');
  let cutoff = 0;
  if (operation.kind === 'retention') {
    const days = operation.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const now = operation.now === undefined ? Date.now() : Date.parse(operation.now);
    if (!Number.isFinite(days) || days < 0 || !Number.isFinite(now)) throw new TypeError('Invalid retention period');
    cutoff = now - days * DAY_MS;
  } else if (operation.kind === 'rescan') {
    const rules = operation.rules;
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)
      || rules.defaults !== undefined && typeof rules.defaults !== 'boolean'
      || rules.patterns !== undefined && (!Array.isArray(rules.patterns)
        || rules.patterns.some(pattern => typeof pattern !== 'string' && !(pattern instanceof RegExp)))) {
      throw new TypeError('Invalid redaction rules');
    }
    if (validateRules(operation.rules).length) throw new TypeError('Invalid redaction rules');
  } else if (operation.kind !== 'scope' || !STORAGE_SCOPES.includes(operation.scope)) throw new TypeError('Invalid maintenance operation');
  const changes: PayloadChange[] = [];
  for (const row of db.prepare('SELECT fact_id, payload, observed_ts FROM facts WHERE payload IS NOT NULL ORDER BY seq').iterate()) {
    const before = String(row.payload);
    const payload = JSON.parse(before) as JsonValue;
    let after: string | null;
    if (operation.kind === 'retention') {
      // メタだけの事実は無期限。本文を持つ事実の payload だけを消す。
      if (Date.parse(String(row.observed_ts)) >= cutoff
        || JSON.stringify(restrictStoredPayload(payload, 'metadata')) === JSON.stringify(payload)) continue;
      after = null;
    } else {
      const next = operation.kind === 'scope' ? restrictStoredPayload(payload, operation.scope) : redactValue(payload, operation.rules);
      if (JSON.stringify(next) === JSON.stringify(payload)) continue;
      after = JSON.stringify(next);
    }
    changes.push({ fact_id: String(row.fact_id), before, after });
  }
  return { operation: structuredClone(operation), changes, fingerprint: fingerprintFacts(db) };
}

function bindProjectionTransaction(db: DatabaseSync): DatabaseSync {
  // rebuild の独立トランザクションを保存点に替え、本文と投影を一括で確定する。
  return new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => target.exec(sql === 'BEGIN IMMEDIATE'
      ? 'SAVEPOINT maintenance_projection' : sql === 'COMMIT'
        ? 'RELEASE maintenance_projection' : sql === 'ROLLBACK'
          ? 'ROLLBACK TO maintenance_projection; RELEASE maintenance_projection' : sql);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export interface MaintenanceBlobs { apply(): void; rollback(): void }

export function applyMaintenance(db: DatabaseSync, plan: MaintenancePlan, prepareBlobs?: () => MaintenanceBlobs): number {
  db.exec('PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
  let blobs: MaintenanceBlobs | undefined;
  let blobsStarted = false;
  try {
    // 追加や時刻の変更も含め、試算時と同じ対象であることをロック内で確かめる。
    if (fingerprintFacts(db) !== plan.fingerprint) throw new Error('Maintenance preview is stale');
    blobs = prepareBlobs?.();
    const update = db.prepare('UPDATE facts SET payload = ? WHERE fact_id = ? AND payload = ?');
    for (const change of plan.changes) {
      if (Number(update.run(change.after, change.fact_id, change.before).changes) !== 1) throw new Error('Maintenance preview is stale');
    }
    if (plan.operation.kind === 'rescan') {
      db.exec('DELETE FROM search_sources WHERE fact_id IN (SELECT fact_id FROM facts WHERE payload IS NOT NULL); DELETE FROM search_references');
      const updateDependency = db.prepare('UPDATE OR REPLACE fact_projection_dependencies SET key = ? WHERE projection = ? AND subject = ? AND direction = ? AND key = ? AND seq = ?');
      for (const row of db.prepare('SELECT * FROM fact_projection_dependencies').all()) {
        updateDependency.run(redact(String(row.key), plan.operation.rules).text, String(row.projection), String(row.subject), String(row.direction), String(row.key), Number(row.seq));
      }
      // 符号化済みの参照への文字置換では一致しない規則も、元の値から再計算する。
      db.exec('DELETE FROM fact_projection_dependencies WHERE seq IN (SELECT seq FROM facts WHERE payload IS NOT NULL)');
      const insertDependency = db.prepare('INSERT OR IGNORE INTO fact_projection_dependencies VALUES (?, ?, ?, ?, ?)');
      for (const row of db.prepare('SELECT * FROM facts WHERE payload IS NOT NULL').iterate()) {
        const fact = { ...row, payload: JSON.parse(String(row.payload)) } as Fact;
        for (const dependency of collectProjectionDependencies(fact)) {
          insertDependency.run(dependency.projection, fact.subject, dependency.direction, dependency.key, fact.seq);
        }
      }
      const updateMetadata = db.prepare('UPDATE search_sources SET metadata = ? WHERE fact_id = ?');
      for (const row of db.prepare('SELECT fact_id, metadata FROM search_sources').all()) {
        updateMetadata.run(JSON.stringify(redactValue(JSON.parse(String(row.metadata)), plan.operation.rules)), String(row.fact_id));
      }
    }
    rebuild(bindProjectionTransaction(db));
    blobsStarted = true;
    blobs?.apply();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); }
    finally { if (blobsStarted) blobs?.rollback(); }
    throw error;
  }
  // 更新前の本文を含む WAL も、読み取り中の接続がなければ切り詰める。
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return plan.changes.length;
}
