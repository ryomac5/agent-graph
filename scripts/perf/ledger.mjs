import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, statSync, renameSync } from 'node:fs';
import { LATEST_MESSAGE_SQL } from '../../packages/api/src/service/summary-index.ts';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { loadConversationWindow } from '../../packages/dashboard/app/src/lib/projection-client.ts';
import { PERF, measure, summarize, REPEATS } from './baseline.mjs';

mkdirSync(PERF, { recursive: true });
const path = join(PERF, 'ledger.db');
if (process.env.PERF_REUSE_DB !== '1') {
  const fresh = join(PERF, `backup-${Date.now()}.db`);
  execFileSync('sqlite3', ['-readonly', join(homedir(), '.local/state/agent-graph/agent-graph.db'), `.backup '${fresh.replaceAll("'", "''")}'`], { timeout: 180000 });
  renameSync(fresh, path);
}
const db = new DatabaseSync(path, { readOnly: true });
const counts = Object.fromEntries(['facts', 'conversations', 'messages', 'message_memberships', 'runs'].map(table => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n)]));
const selected = db.prepare('SELECT conversation_id AS id, count(*) AS count FROM message_memberships WHERE active = 1 GROUP BY conversation_id ORDER BY count DESC').all();
const long = selected[0];
const short = selected.find(row => row.count >= 5 && row.count <= 20) ?? selected.at(-1);
const state = db.prepare('SELECT last_seq,generation FROM projection_state WHERE id=1').get();
const start = performance.now();
const feed = new ProjectionFeed(path, () => state);
const initializationMs = performance.now() - start;
const sqls = [
  ['last_seq', 'SELECT max(seq) AS seq FROM facts', []],
  ['tail_1024', 'SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT 1024', [Math.max(0, Number(state.last_seq) - 1024)]],
  ['observation_context', `SELECT * FROM facts WHERE seq > ? AND seq <= ? AND kind NOT LIKE 'message_membership.%' AND (kind NOT LIKE 'message.%' OR subject LIKE '%history-unavailable%') ORDER BY seq LIMIT 1024`, [0, state.last_seq]],
  ['subject_history', 'SELECT * FROM facts WHERE subject = ? ORDER BY seq', ['conversation:' + long.id]],
  ...[long, short].map((row, i) => [i ? 'conversation_short_200' : 'conversation_long_200', 'SELECT m.*, mm.id AS membership_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id WHERE mm.conversation_id = ? AND mm.active = 1 AND m.id > ? ORDER BY m.id LIMIT ?', [row.id, '', 200]]),
  ['message_summary_long', LATEST_MESSAGE_SQL, [long.id, long.id]],
  ['identity_startup', `SELECT seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes,
    json_patch('{}', json_object('provider', json_extract(payload, '$.provider'), 'native_id', json_extract(payload, '$.native_id'),
      'conversation_id', json_extract(payload, '$.conversation_id'), 'generation', json_extract(payload, '$.generation'))) AS payload
    FROM facts WHERE seq <= ? AND (kind GLOB 'conversation.*' OR kind = 'run.created') ORDER BY subject, seq`, [state.last_seq]],
  ['active_observed_runs', `SELECT c.id,r.generation FROM runs r JOIN conversations c ON r.conversation_id IN (c.id,c.provider || ':' || c.native_id) WHERE c.provider=? AND c.origin='observed' AND r.state IN ('running','waiting_approval','waiting_input') AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.conversation_id IN (c.id,c.provider || ':' || c.native_id) AND newer.generation>r.generation)`, ['codex']],
];
const queries = sqls.map(([name, sql, parameters]) => {
  const statement = db.prepare(sql);
  const timing = measure(() => statement.all(...parameters));
  return { name, sql, parameters, ...timing, value: undefined, rows: timing.value.length, plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => row.detail) };
});
const snapshot = measure(() => feed.snapshot());
const snapshotSerialize = measure(() => JSON.stringify(snapshot.value));
const idleRefresh = measure(() => feed.refresh());
const conversations = [];
for (const [kind, row] of [['long', long], ['short', short]]) {
  const first = measure(() => feed.conversation(row.id));
  const windowTimes = [];
  const sqlTimes = [];
  let pages, bytes, messageCount;
  for (let i = 0; i < REPEATS; i++) {
    pages = 0; bytes = 0;
    let sqlMs = 0;
    const began = performance.now();
    const value = await loadConversationWindow(row.id, new AbortController().signal, undefined, undefined, async route => {
      const url = new URL(route, 'http://localhost');
      const beginSql = performance.now();
      const result = feed.conversation(url.searchParams.get('id'), url.searchParams.get('after') ?? '');
      sqlMs += performance.now() - beginSql;
      const encoded = JSON.stringify(result);
      pages++; bytes += Buffer.byteLength(encoded);
      return JSON.parse(encoded);
    });
    windowTimes.push(performance.now() - began); sqlTimes.push(sqlMs); messageCount = value.projection.messages.length;
  }
  conversations.push({ kind, ...row, firstPage: { ...first, value: undefined, bytes: Buffer.byteLength(JSON.stringify(first.value)) }, window: summarize(windowTimes), sql: summarize(sqlTimes), pages, bytes, retainedMessages: messageCount });
}
console.log(JSON.stringify({ counts, databaseBytes: statSync(path).size, selected: { long, short }, queries, feed: { initializationMs, initializationN: 1, snapshot: { ...snapshot, value: undefined, bytes: Buffer.byteLength(snapshotSerialize.value) }, snapshotSerialize: { ...snapshotSerialize, value: undefined }, idleRefresh: { ...idleRefresh, value: undefined } }, conversations }));
feed.close(); db.close();
