import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync, brotliCompressSync, deflateRawSync, constants } from 'node:zlib';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { deriveRunId } from '../../packages/api/src/service/screen-identities.ts';
import { measure } from './baseline.mjs';
import { BROTLI_OPTIONS, GZIP_OPTIONS } from '../../packages/api/src/ws/compression.ts';
import { measureTransport } from './transport.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUTPUT = join(ROOT, '.perf/snapshot');
const DB = process.env.AGENT_GRAPH_PERF_DB ?? join(homedir(), '.local/state/agent-graph/agent-graph.db');
const bytes = value => Buffer.byteLength(JSON.stringify(value));

export function describeSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  const tables = Object.fromEntries(Object.entries(snapshot.projection).map(([table, rows]) => {
    const fields = {};
    for (const row of rows) for (const [key, value] of Object.entries(row)) {
      const field = fields[key] ??= { count: 0, bytes: 0, valueBytes: 0 };
      field.count++;
      field.valueBytes += bytes(value);
      field.bytes += bytes(key) + 1 + bytes(value);
    }
    return [table, { rows: rows.length, bytes: bytes(rows), fields }];
  }));
  return { seq: snapshot.seq, generation: snapshot.generation, bytes: Buffer.byteLength(json),
    gzipBytes: gzipSync(json, GZIP_OPTIONS).length, brotliBytes: brotliCompressSync(json, BROTLI_OPTIONS).length,
    deflateBytes: deflateRawSync(json, { ...GZIP_OPTIONS, finishFlush: constants.Z_SYNC_FLUSH }).length - 4,
    sections: Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, bytes(value)])),
    identities: Object.fromEntries(Object.entries(snapshot.identities ?? {}).map(([key, value]) =>
      [key, { entries: Object.keys(value).length, bytes: bytes(value) }])), tables,
  };
}

function verifySnapshot(before, after) {
  const restored = structuredClone(after);
  for (const row of restored.projection.relations) {
    let parts;
    try { parts = JSON.parse(row.id); } catch { continue; }
    if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(value => typeof value === 'string')) continue;
    ['type', 'from_id', 'to_id', 'evidence'].forEach((key, index) => { if (!(key in row)) row[key] = parts[index]; });
  }
  for (const key of ['seq', 'generation', 'pages', 'projection']) {
    if (!isDeepStrictEqual(before[key], restored[key])) throw new Error(`Snapshot mismatch: ${key}`);
  }
  if (!isDeepStrictEqual(before.identities.conversations, after.identities.conversations)) throw new Error('Conversation identity mismatch');
  for (const [id, canonical] of Object.entries(before.identities.runs)) {
    if ((after.identities.runs[id] ?? deriveRunId(id, after.identities.conversations)) !== canonical) throw new Error('Run identity mismatch');
  }
  return 'All projection rows, pages, seq, generation and legacy/run ID resolutions match';
}

// 書き込みを行う constructor と catchUp は呼ばず、既存の API 補助表を読む。
// snapshot/list/readRoots は本物の実装を使う。測定中の DB は一つの読み取り取引に固定する。
export function createReadOnlyFeed(Feed, db) {
  const feed = Object.create(Feed.prototype);
  const conversations = Object.fromEntries(db.prepare('SELECT id, canonical_id FROM api_conversation_ids').all()
    .map(row => [row.id, row.canonical_id]));
  const runs = {};
  const state = db.prepare('SELECT last_seq, generation FROM projection_state WHERE id = 1').get();
  const subjects = db.prepare(`SELECT json_extract(payload, '$.conversation_id') AS conversation_id,
    json_extract(payload, '$.generation') AS generation, substr(subject, 5) AS subject_id
    FROM facts WHERE kind = 'run.created' AND seq <= ? ORDER BY subject, seq`).all(state.last_seq);
  for (const row of [...db.prepare('SELECT conversation_id, generation, subject_id FROM run_subjects').all(), ...subjects]) {
    if (!row.conversation_id || row.generation === null) continue;
    const canonical = `${conversations[row.conversation_id] ?? row.conversation_id}:${row.generation}`;
    for (const id of [row.subject_id, `${row.conversation_id}:${row.generation}`]) {
      if (id === canonical) delete runs[id];
      else runs[id] = canonical;
    }
  }
  Object.assign(feed, { db, state,
    statements: new Map(), identities: { conversations, runs }, inputQueues: new Map() });
  feed.updateInputQueues();
  feed.roots = feed.readRoots();
  return feed;
}

async function loadBaseline(ref) {
  const file = 'packages/api/src/service/projection-feed.ts';
  const source = execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8' });
  const rewritten = source.replace(/from (["'])(\.[^"']+)\1/g, (_, quote, path) =>
    `from ${quote}${pathToFileURL(resolve(ROOT, 'packages/api/src/service', path)).href}${quote}`);
  const path = join(OUTPUT, 'baseline-feed.ts');
  writeFileSync(path, rewritten);
  return (await import(pathToFileURL(path).href)).ProjectionFeed;
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true });
  const ref = process.argv.find(arg => arg.startsWith('--compare='))?.slice('--compare='.length);
  const Baseline = ref ? await loadBaseline(ref) : undefined;
  const db = new DatabaseSync(DB, { readOnly: true });
  db.exec('BEGIN');
  const result = { timestamp: new Date().toISOString(), node: process.version, mode: 'DatabaseSync readOnly',
    baselineCommit: ref ? execFileSync('git', ['rev-parse', ref], { cwd: ROOT, encoding: 'utf8' }).trim() : undefined,
    note: 'Existing API projections; no catchUp, rebuild, service restart, observation metadata or in-memory send watches. Transport uses in-memory HTTP/ws streams, not production networking.' };
  let previous;
  let conversationId = process.env.AGENT_GRAPH_PERF_CONVERSATION;
  const payloads = {};
  try {
    for (const [name, Feed] of [...(Baseline ? [['before', Baseline]] : []), ['after', ProjectionFeed]]) {
      const feed = createReadOnlyFeed(Feed, db);
      const { value: snapshot, ...snapshotMs } = measure(() => feed.snapshot());
      const { value: json, ...serializeMs } = measure(() => JSON.stringify(snapshot));
      const { value: ignored, ...parseMs } = measure(() => JSON.parse(json));
      result[name] = { ...describeSnapshot(snapshot), snapshotMs, serializeMs, parseMs };
      payloads[`${name}Snapshot`] = snapshot;
      if (!conversationId) {
        let largest = 0;
        for (const root of snapshot.projection.roots) {
          const size = bytes(feed.conversation(root.current_conversation_id, '', { latest: true }));
          if (size > largest) { largest = size; conversationId = root.current_conversation_id; }
        }
      }
      if (!conversationId) throw new Error('No conversation; set AGENT_GRAPH_PERF_CONVERSATION');
      const conversation = feed.conversation(conversationId, '', { latest: true });
      result[name].conversation = { ...describeSnapshot(conversation), selection: 'Largest latest window among initial roots (or AGENT_GRAPH_PERF_CONVERSATION)', id: conversationId };
      payloads[`${name}Conversation`] = conversation;
      payloads[`${name}Page`] = feed.list('relations');
      if (name === 'before') previous = JSON.parse(json);
      else if (previous) {
        result.equivalence = verifySnapshot(previous, JSON.parse(json));
        if (!isDeepStrictEqual(payloads.beforeConversation, conversation)) throw new Error('Conversation mismatch');
      }
    }
    result.databaseChanges = db.prepare('SELECT total_changes() AS count').get().count;
  } finally { db.exec('ROLLBACK'); db.close(); }
  for (const name of ['before', 'after']) if (payloads[`${name}Snapshot`]) {
    const snapshot = payloads[`${name}Snapshot`];
    payloads[`${name}Patch`] = { type: 'patch', from_seq: snapshot.seq - 1, seq: snapshot.seq, generation: snapshot.generation,
      changes: { relations: { upsert: snapshot.projection.relations, remove: [] } } };
  }
  payloads.smallPatch = { type: 'patch', from_seq: 1, seq: 2, generation: 0, changes: { runs: { upsert: [{ id: 'example:1', state: 'running' }], remove: [] } } };
  result.transport = await measureTransport(payloads);
  writeFileSync(join(OUTPUT, 'report.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
