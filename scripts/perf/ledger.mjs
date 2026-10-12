import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, statSync, renameSync } from 'node:fs';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { loadConversationEdits, loadConversationWindow } from '../../packages/dashboard/app/src/lib/projection-client.ts';
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
const sqls = [
  ['last_seq', 'SELECT max(seq) AS seq FROM facts', []],
  ['tail_1024', 'SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT 1024', [Math.max(0, Number(state.last_seq) - 1024)]],
  ['observation_context', `SELECT * FROM facts WHERE seq > ? AND seq <= ? AND kind NOT LIKE 'message_membership.%' AND (kind NOT LIKE 'message.%' OR subject LIKE '%history-unavailable%') ORDER BY seq LIMIT 1024`, [0, state.last_seq]],
  ['subject_history', 'SELECT * FROM facts WHERE subject = ? ORDER BY seq', ['conversation:' + long.id]],
  ...[long, short].map((row, i) => [i ? 'conversation_short_200' : 'conversation_long_200', 'SELECT m.*, mm.id AS membership_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id WHERE mm.conversation_id = ? AND mm.active = 1 AND m.id > ? ORDER BY m.id LIMIT ?', [row.id, '', 200]]),
  ['message_summary_long', `SELECT m.id, m.source_ts, m.source_event_id FROM message_memberships mm JOIN messages m ON m.id = mm.message_id
    WHERE mm.conversation_id = ? AND mm.active = 1 AND julianday(m.source_ts) = (SELECT max(julianday(m2.source_ts))
      FROM message_memberships mm2 JOIN messages m2 ON m2.id = mm2.message_id WHERE mm2.conversation_id = ? AND mm2.active = 1)`, [long.id, long.id]],
  ['identity_startup', `SELECT seq, fact_id, source, source_event_id, kind, subject, source_ts, observed_ts, confidence, supersedes,
    json_patch('{}', json_object('provider', json_extract(payload, '$.provider'), 'native_id', json_extract(payload, '$.native_id'),
      'conversation_id', json_extract(payload, '$.conversation_id'), 'generation', json_extract(payload, '$.generation'))) AS payload
    FROM facts WHERE seq <= ? AND (kind LIKE 'conversation.%' OR kind = 'run.created') ORDER BY subject, seq`, [state.last_seq]],
  ['active_observed_runs', `SELECT c.id,r.generation FROM runs r JOIN conversations c ON r.conversation_id IN (c.id,c.provider || ':' || c.native_id) WHERE c.provider=? AND c.origin='observed' AND r.state IN ('running','waiting_approval','waiting_input') AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.conversation_id IN (c.id,c.provider || ':' || c.native_id) AND newer.generation>r.generation)`, ['codex']],
];
const queries = sqls.map(([name, sql, parameters]) => {
  const statement = db.prepare(sql);
  const timing = measure(() => statement.all(...parameters));
  return { name, sql, parameters, ...timing, value: undefined, rows: timing.value.length, plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => row.detail) };
});
const start = performance.now();
const feed = new ProjectionFeed(path, () => state);
const initializationMs = performance.now() - start;
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
      const result = feed.conversation(url.searchParams.get('id'), url.searchParams.get('after') ?? '', { latest: url.searchParams.get('latest') === '1', before: url.searchParams.get('before') ?? undefined, message: url.searchParams.get('message') ?? undefined });
      sqlMs += performance.now() - beginSql;
      const encoded = JSON.stringify(result);
      pages++; bytes += Buffer.byteLength(encoded);
      return JSON.parse(encoded);
    });
    windowTimes.push(performance.now() - began); sqlTimes.push(sqlMs); messageCount = value.projection.messages.length;
  }
  const extras = {};
  for (const operation of ['older', 'edits']) {
    const times = [];
    let requests = 0, responseBytes = 0, retained = 0;
    for (let i = 0; i < REPEATS; i++) {
      requests = 0; responseBytes = 0;
      const fetchPage = async route => {
        const url = new URL(route, 'http://localhost');
        const result = feed.conversation(row.id, url.searchParams.get('after') ?? '', {
          latest: url.searchParams.get('latest') === '1', before: url.searchParams.get('before') ?? undefined,
          edits: url.searchParams.get('edits') === '1',
        });
        const encoded = JSON.stringify(result);
        requests++; responseBytes += Buffer.byteLength(encoded);
        return JSON.parse(encoded);
      };
      const latest = feed.conversation(row.id, '', { latest: true });
      const began = performance.now();
      if (operation === 'older') {
        const value = await loadConversationWindow(row.id, new AbortController().signal, latest.projection.messages[0], undefined, fetchPage);
        retained = value.projection.messages.length;
      } else {
        const value = await loadConversationEdits(row.id, new AbortController().signal, fetchPage);
        retained = value.length;
      }
      times.push(performance.now() - began);
    }
    extras[operation] = { ...summarize(times), pages: requests, bytes: responseBytes, retainedMessages: retained };
  }
  conversations.push({ kind, ...extras, ...row, firstPage: { ...first, value: undefined, bytes: Buffer.byteLength(JSON.stringify(first.value)) }, window: summarize(windowTimes), sql: summarize(sqlTimes), pages, bytes, retainedMessages: messageCount });
}
console.log(JSON.stringify({ counts, databaseBytes: statSync(path).size, selected: { long, short }, queries, feed: { initializationMs, initializationN: 1, snapshot: { ...snapshot, value: undefined, bytes: Buffer.byteLength(snapshotSerialize.value) }, snapshotSerialize: { ...snapshotSerialize, value: undefined }, idleRefresh: { ...idleRefresh, value: undefined } }, conversations }));
feed.close(); db.close();
