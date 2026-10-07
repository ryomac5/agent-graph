import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { applyMaintenance, planMaintenance, type MaintenanceOperation, type MaintenancePlan } from '../../../core/src/ledger/retention.ts';
import { DEFAULT_RETENTION_DAYS } from '../../../core/src/ledger/ledger.ts';
import { redact } from '../../../core/src/ledger/redact.ts';
import type { ScreenCommand } from '../ws/contract.ts';
import type { RunnerRequest, RunnerResponse } from '../runner-client.ts';

export const MAINTENANCE_COMMANDS = ['maintenance.preview', 'maintenance.retention', 'maintenance.rescan', 'maintenance.scope'] as const;
interface BlobChange { name: string; before: string; after: string | null; target?: string }
interface Preview { plan: MaintenancePlan; blobs: BlobChange[]; fingerprint: string }
export interface MaintenanceOptions { db: DatabaseSync; blobsPath: string; resync?(): void }
const DAY_MS = 86_400_000;
const HASH_NAME = /^[a-f0-9]{64}$/;
function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
function readBlobs(path: string): { name: string; body: string }[] {
  let names: string[];
  try { names = readdirSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter(name => HASH_NAME.test(name)).sort().map(name => {
    const file = join(path, name);
    if (!lstatSync(file).isFile()) throw new Error('Invalid blob file');
    return { name, body: readFileSync(file, 'utf8') };
  });
}
function collectHashes(value: unknown, hashes: Set<string>): void {
  if (typeof value === 'string') {
    if (HASH_NAME.test(value)) hashes.add(value);
    hashes.add(hash(value));
  } else if (value && typeof value === 'object') for (const child of Object.values(value)) collectHashes(child, hashes);
}
function replaceHashes(value: unknown, replacements: Map<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(child => replaceHashes(child, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceHashes(child, replacements)]));
  return value;
}

export class MaintenanceService {
  private previews = new Map<string, Preview>();
  private receipts = new Map<string, { fingerprint: string; response: RunnerResponse }>();
  private options: MaintenanceOptions;
  constructor(options: MaintenanceOptions) { this.options = options; }
  private build(operation: MaintenanceOperation): Preview {
    const plan = planMaintenance(this.options.db, operation);
    const expiredHashes = new Set<string>();
    const retainedHashes = new Set<string>();
    if (operation.kind === 'retention') {
      const cutoff = Date.parse(operation.now!) - (operation.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
      for (const row of this.options.db.prepare('SELECT payload, observed_ts FROM facts WHERE payload IS NOT NULL').iterate()) {
        collectHashes(JSON.parse(String(row.payload)),
          Date.parse(String(row.observed_ts)) < cutoff ? expiredHashes : retainedHashes);
      }
    }
    const blobs: BlobChange[] = [];
    const replacements = new Map<string, string>();
    const stored = readBlobs(this.options.blobsPath);
    for (const { name, body } of stored) {
      const after = operation.kind === 'rescan' ? redact(body, operation.rules).text
        : (operation.kind === 'scope' && operation.scope !== 'full_diff')
          || (expiredHashes.has(name) && !retainedHashes.has(name)) ? null : body;
      if (after === body) continue;
      const target = after === null ? undefined : hash(after);
      blobs.push({ name, before: body, after, target });
      if (target) replacements.set(name, target);
    }
    if (replacements.size) {
      const changes = new Map(plan.changes.map(change => [change.fact_id, change]));
      for (const row of this.options.db.prepare('SELECT fact_id, payload FROM facts WHERE payload IS NOT NULL').all()) {
        const id = String(row.fact_id);
        const before = String(row.payload);
        const current = changes.get(id)?.after ?? before;
        const after = JSON.stringify(replaceHashes(JSON.parse(current), replacements));
        if (JSON.stringify(JSON.parse(current)) !== after) changes.set(id, { fact_id: id, before, after });
      }
      plan.changes = [...changes.values()];
    }
    // 件数が同じでも対象が変われば、削除の確認を取り直す。
    return { plan, blobs, fingerprint: hash(JSON.stringify({ facts: plan.fingerprint, stored, operation })) };
  }
  preview(operation: MaintenanceOperation) {
    if (!operation || typeof operation !== 'object') throw new TypeError('Invalid maintenance operation');
    const normalized = operation.kind === 'retention' ? { ...operation, now: operation.now ?? new Date().toISOString() } : operation;
    const preview = this.build(normalized);
    const token = randomUUID();
    this.previews.set(token, preview);
    return { token, facts: preview.plan.changes.length, blobs: preview.blobs.length };
  }
  execute(token: string, kind: MaintenanceOperation['kind']) {
    const preview = this.previews.get(token);
    if (!preview || preview.plan.operation.kind !== kind) throw new TypeError('Matching maintenance preview required');
    const facts = applyMaintenance(this.options.db, preview.plan, () => {
      // 台帳の書き込みロック内で再確認し、並行する追記から共有 blob を守る。
      if (this.build(preview.plan.operation).fingerprint !== preview.fingerprint) throw new TypeError('Maintenance preview is stale');
      const originals = new Map(readBlobs(this.options.blobsPath).map(blob => [blob.name, blob.body]));
      const targets = new Set(preview.blobs.flatMap(blob => blob.target ? [blob.target] : []));
      return { apply: () => {
        // 投影に失敗した場合は保存庫も変えない。削除は DB の確定直前に行う。
        for (const blob of preview.blobs) {
          if (blob.after !== null) {
            const target = join(this.options.blobsPath, blob.target!);
            const temporary = `${target}.${randomUUID()}.tmp`;
            try { writeFileSync(temporary, blob.after, { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); }
            finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
          }
        }
        // 置換先も元の名前に含まれる場合に、新しく保存した本文を消さない。
        for (const blob of preview.blobs) {
          if (!targets.has(blob.name)) unlinkSync(join(this.options.blobsPath, blob.name));
        }
      }, rollback: () => {
        // 保存庫の途中の失敗や COMMIT の失敗でも、元の本文と参照を復元する。
        for (const name of new Set([...preview.blobs.map(blob => blob.name), ...targets])) {
          const original = originals.get(name);
          const file = join(this.options.blobsPath, name);
          if (original !== undefined) writeFileSync(file, original, { mode: 0o600 });
          else {
            try { unlinkSync(file); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          }
        }
      } };
    });
    this.previews.delete(token);
    this.options.resync?.();
    return { facts, blobs: preview.blobs.length };
  }
  async handle(message: ScreenCommand): Promise<RunnerResponse> {
    const fingerprint = hash(JSON.stringify({ command: message.command, payload: message.payload }));
    const previous = this.receipts.get(message.cmd_id);
    if (previous) return previous.fingerprint === fingerprint ? previous.response
      : { type: 'res', cmd_id: message.cmd_id, ok: false, error: 'cmd_id reused for another command' };
    try {
      if (!(MAINTENANCE_COMMANDS as readonly string[]).includes(message.command)) throw new TypeError('Unknown maintenance command');
      if (!message.payload || typeof message.payload !== 'object' || Array.isArray(message.payload)) throw new TypeError('Invalid maintenance payload');
      const p = message.payload;
      const kind = message.command.slice('maintenance.'.length);
      const result = message.command === 'maintenance.preview'
        ? this.preview(p.operation as unknown as MaintenanceOperation)
        : ['retention', 'rescan', 'scope'].includes(kind) && p.confirmation === true && typeof p.token === 'string'
          ? this.execute(p.token, kind as MaintenanceOperation['kind'])
          : (() => { throw new TypeError('Confirmed maintenance preview required'); })();
      const response: RunnerResponse = { type: 'res', cmd_id: message.cmd_id, ok: true, result };
      this.receipts.set(message.cmd_id, { fingerprint, response });
      return response;
    } catch (error) {
      return { type: 'res', cmd_id: message.cmd_id, ok: false, error: error instanceof TypeError ? error.message : 'Maintenance operation failed' };
    }
  }
}

export function bindMaintenanceRequests(port: { request(request: RunnerRequest): Promise<RunnerResponse> }, service: MaintenanceService): () => void {
  const original = port.request;
  port.request = async request => request.command.startsWith('maintenance.')
    ? service.handle({ ...request, type: 'cmd' }) : original.call(port, request);
  return () => { port.request = original; };
}
