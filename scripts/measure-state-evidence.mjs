// 本番は読取専用で複製し、本文を出力せず、保存済み cursor までの新規証拠の追記量を見積もる。
import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { captureNativeRecord } from '../packages/core/src/state/capture.ts';
import { findUnsupportedReason } from '../packages/api/src/observe/claude/index.ts';
import { createNativeEvidenceBuffer } from '../packages/api/src/observe/native-evidence.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const source = option('--source', join(homedir(), '.local/state/agent-graph/agent-graph.db'));
const copy = resolve(option('--copy', '.agents/measure/prod.db'));
const output = resolve(option('--output', '.agents/measure/growth.json'));
const from = option('--from', '2026-10-09'), through = option('--through', '2026-10-15');
const revision = option('--before', '87dc0cc');
mkdirSync(dirname(copy), { recursive: true });
if (!existsSync(copy)) {
  const original = new DatabaseSync(source, { readOnly: true });
  original.exec('PRAGMA query_only=ON');
  try { await backup(original, copy); } finally { original.close(); }
}
const captureUrl = pathToFileURL(resolve('packages/core/src/state/capture.ts'));
captureUrl.search = '?measurement-baseline';
const hook = registerHooks({ load(url, context, next) {
  if (url !== captureUrl.href) return next(url, context);
  return { format: 'module-typescript', source: execFileSync('git', ['show', `${revision}:packages/core/src/state/capture.ts`], { encoding: 'utf8' }), shortCircuit: true };
} });
const before = (await import(captureUrl.href)).captureNativeRecord;
hook.deregister();
const db = new DatabaseSync(copy, { readOnly: true }); db.exec('PRAGMA query_only=ON; BEGIN');
const latest = db.prepare('SELECT max(seq) AS maxSeq,max(observed_ts) AS observedThrough FROM facts').get();
const days = new Map();
const dayOf = at => new Date(Date.parse(at) + 9 * 3600000).toISOString().slice(0, 10);
const get = day => { if (!days.has(day)) days.set(day, { existing: 0, observed: 0, beforeClaude: 0, beforeCodex: 0,
  retained: 0, singleRowWrites: 0, oneSecondWrites: 0, backfillWrites: 0, beforeBytes: 0, oneSecondBytes: 0, backfillBytes: 0 }); return days.get(day); };
for (const row of db.prepare("SELECT date(source_ts,'+9 hours') AS day,count(*) AS n FROM facts GROUP BY 1").all()) get(row.day).existing = row.n;
for (const row of db.prepare("SELECT date(observed_ts,'+9 hours') AS day,count(*) AS n FROM facts GROUP BY 1").all()) get(row.day).observed = row.n;
const managed = new Set(db.prepare("SELECT native_id FROM conversations WHERE provider='claude' AND origin='managed'").all().map(row => row.native_id));
const cursors = db.prepare('SELECT path,state FROM api_observation_cursors').all().filter(row => /\.(claude|codex)\//.test(row.path) && row.path.endsWith('.jsonl'));
let missing = 0, invalid = 0, untimed = 0, rawCandidates = 0, retained = 0;
for (const { path, state } of cursors) {
  const provider = path.includes('/.claude/') ? 'claude' : 'codex';
  if (provider === 'claude' && managed.has(basename(path, '.jsonl'))) continue;
  const limit = JSON.parse(state).cursor?.offset;
  if (!(limit > 0)) continue;
  if (!existsSync(path)) { missing++; continue; }
  let offset = 0, fileNative = basename(path, '.jsonl'), generation = 1, currentBucket;
  const emitted = mode => input => {
    const counts = get(dayOf(input.source_ts)); counts[`${mode}Writes`]++;
    counts[`${mode}Bytes`] += Buffer.byteLength(JSON.stringify(input));
  };
  let live = createNativeEvidenceBuffer(new Set(), emitted('oneSecond'));
  let history = createNativeEvidenceBuffer(new Set(), emitted('backfill'));
  let historyDay;
  const lines = createInterface({ input: createReadStream(path, { end: limit - 1 }), crlfDelay: Infinity });
  for await (const text of lines) {
    const start = offset; offset += Buffer.byteLength(text) + 1;
    let row;
    try { row = JSON.parse(text); } catch { invalid++; continue; }
    if (provider === 'claude' && findUnsupportedReason(row)) continue;
    if (row.type === 'session_meta') { fileNative = row.payload?.id ?? fileNative; continue; }
    const previous = before(provider, row), current = captureNativeRecord(provider, row);
    if (!previous && !current) continue;
    const at = row.timestamp;
    if (!Number.isFinite(Date.parse(at))) { untimed++; continue; }
    const day = dayOf(at), counts = get(day);
    if (previous) { rawCandidates++; counts[provider === 'claude' ? 'beforeClaude' : 'beforeCodex']++; }
    if (current) { retained++; counts.retained++; counts.singleRowWrites++; }
    const native = row.params?.threadId ?? row.threadId ?? row.payload?.thread_id ?? row.payload?.threadId ?? fileNative;
    const conversation = JSON.stringify([provider, native]);
    const input = { source: provider === 'claude' ? 'transcript-claude' : 'rollout-codex', source_event_id: `native-record:${provider === 'claude' ? conversation : basename(path)}:${start}:${createHash('sha256').update(text).digest('hex')}`,
      kind: 'run.updated', subject: `run:${conversation}:${generation}`, source_ts: at, observed_ts: latest.observedThrough, confidence: 'confirmed', cursor: null,
      payload: { conversation_id: conversation, generation, last_evidence_ts: at, last_evidence: { native_source: provider, file_id: basename(path), native_record: previous } } };
    if (previous) counts.beforeBytes += Buffer.byteLength(JSON.stringify(input));
    if (!current) continue;
    input.payload.last_evidence.native_record = current;
    const bucket = Math.floor(Date.parse(at) / 1000);
    if (currentBucket !== bucket) { live.flush(); live = createNativeEvidenceBuffer(new Set(), emitted('oneSecond')); currentBucket = bucket; }
    if (historyDay !== day) { history.flush(); history = createNativeEvidenceBuffer(new Set(), emitted('backfill')); historyDay = day; }
    live.add(input); history.add(input);
    // 親子の関係の追記前にも実装は flush する。協調の行では保守的に両方を区切る。
    if (row.params?.item?.type === 'collabAgentToolCall' || row.payload?.item?.type === 'SubAgentActivity') { live.flush(); history.flush(); }
  }
  live.flush(); history.flush();
}
db.exec('COMMIT'); db.close();
const selected = [...days].filter(([day]) => day >= from && day <= through).sort().map(([day, counts]) => ({ day, ...counts }));
const totals = Object.fromEntries(Object.keys(selected[0]).filter(key => key !== 'day').map(key => [key, selected.reduce((sum, row) => sum + row[key], 0)]));
const result = { baseline: revision, ...latest, from, through, paths: cursors.length, missing, invalid, untimed, rawCandidates, retained,
  assumptions: ['1秒の到着窓をsource_tsの連続する1秒区間で近似。実際の観測周期・到着順は未記録。',
    'backfillはファイル・会話・活動日ごとの補完。世代は固定した下限寄りの見積もり。singleRowWritesはまとめられない場合の上限。',
    'bytesは候補FactInputのJSON長。SQLiteの索引・ページを含む実容量ではない。既存事実は不変。'],
  days: selected, totals };
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ ...result, days: undefined }));
