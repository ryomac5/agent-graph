import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../packages/core/src/ledger/ledger.ts';
import { SCHEMA_VERSION } from '../packages/core/src/ledger/schema.ts';
import { ledgerDbPath } from '../packages/api/src/paths.ts';

const manifest = JSON.parse(readFileSync(new URL('./hide-verification-conversations.json', import.meta.url), 'utf8'));
const PROTECTED = ['1c0d055c', '354000b1', 'fea1ff97'];
const REASON = 'Reviewed disposable verification conversation (2026-10-14)';

export function verifyCandidates(dbPath, home = homedir(), candidates = manifest.hide) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare('SELECT version FROM schema_version WHERE id = 1').get()?.version !== SCHEMA_VERSION) {
      throw new Error('Schema version differs; this command does not migrate databases');
    }
    const rows = [];
    for (const candidate of candidates) {
      const { provider, nativeId, sha256 } = candidate;
      if (PROTECTED.some(prefix => nativeId.startsWith(prefix))) throw new Error('Protected conversation');
      const directory = join(home, '.claude/projects');
      const paths = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .flatMap(entry => readdirSync(join(directory, entry.name)).filter(name => name === `${nativeId}.jsonl`)
          .map(name => join(directory, entry.name, name)));
      if (paths.length !== 1) throw new Error(`${nativeId}: expected exactly one transcript, found ${paths.length}`);
      const hash = createHash('sha256').update(readFileSync(paths[0])).digest('hex');
      if (hash !== sha256) throw new Error(`${nativeId}: transcript changed; review it again before hiding`);
      const id = JSON.stringify([provider, nativeId]);
      if (!db.prepare('SELECT 1 FROM conversations WHERE id = ? AND provider = ? AND native_id = ?').get(id, provider, nativeId)) {
        throw new Error(`${nativeId}: conversation is missing or has a different identity`);
      }
      const eventId = `hide-verification:2026-10-14:${id}`;
      const existing = db.prepare('SELECT kind, subject, payload FROM facts WHERE source = ? AND source_event_id = ?').get('ui', eventId);
      if (existing && (existing.kind !== 'conversation.hidden' || existing.subject !== `conversation:${id}`
        || JSON.parse(existing.payload ?? '{}').hidden !== true || JSON.parse(existing.payload ?? '{}').hidden_reason !== REASON)) {
        throw new Error(`${nativeId}: conflicting cleanup fact`);
      }
      rows.push({ id, eventId, status: existing ? 'already-hidden' : 'ready', transcript: paths[0], sha256 });
    }
    return rows;
  } finally { db.close(); }
}

export function applyCandidates(dbPath, home = homedir(), candidates = manifest.hide) {
  // 全件の再確認を終えるまで書き込み接続を開かない。既存の台帳だけを扱う。
  const rows = verifyCandidates(dbPath, home, candidates);
  const ledger = openLedger(dbPath);
  try {
    for (const row of rows) {
      const result = ledger.append({ source: 'ui', source_event_id: row.eventId, kind: 'conversation.hidden',
        subject: `conversation:${row.id}`, payload: { hidden: true, hidden_reason: REASON },
        source_ts: '2026-10-14T00:00:00.000Z', confidence: 'confirmed' });
      if (result.status === 'conflict') throw new Error(`${row.id}: conflicting cleanup fact`);
    }
  } finally { ledger.close(); }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (!['verify', 'apply'].includes(mode) || args.length !== 0 && (args.length !== 2 || args[0] !== '--db')) {
    throw new Error('Usage: node scripts/hide-verification-conversations.mjs verify|apply [--db /absolute/path/to/agent-graph.db]');
  }
  const dbPath = args[1] ?? ledgerDbPath();
  const rows = mode === 'apply' ? applyCandidates(dbPath) : verifyCandidates(dbPath);
  console.log(JSON.stringify({ mode, dbPath, conversations: rows, excluded: manifest.excluded }, null, 2));
}
