import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { acquirePerformanceLock } from './perf-lock.ts';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDirectCodexObserver, prepareDirectFacts } from '../../src/observe/direct-codex.ts';
import { rolloutReader } from '../../src/observe/codex/files.ts';
import { openObservationService } from '../../src/service/index.ts';
import type { Fact, Ledger } from '../../../core/src/ledger/index.ts';

// service は realdata.test.ts の build モードで生成した一時台帳に対して実行する。
// direct は本番台帳を読み取り専用で開き、TEMP ビューとメモリ内の追記で再評価する。
const CYCLES = 60;
if (isMainThread) {
  const release = await acquirePerformanceLock();
  const worker = new Worker(new URL(import.meta.url), { workerData: { mode: process.argv[2], path: process.argv[3] } });
  worker.on('message', result => process.stdout.write(JSON.stringify(result) + '\n'));
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', code => code ? reject(new Error(`Benchmark worker exited: ${code}`)) : resolve());
    });
  } finally { await release(); }
} else {
  const times: number[] = [];
  let heapPeak = 0;
  if (workerData.mode === 'service') {
    const home = join(workerData.path, '..', 'empty-home');
    const service = openObservationService({ dbPath: workerData.path, writerOnly: true, home,
      env: { HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') } });
    const started = performance.now();
    service.ingestOnce();
    const startupMs = performance.now() - started;
    for (let i = 0; i < CYCLES; i++) {
      await delay(1000);
      const start = performance.now(); service.ingestOnce(); times.push(performance.now() - start);
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }
    service.close();
    parentPort!.postMessage({ mode: 'service', startupMs, heapPeak, cycleMeanMs: times.reduce((a,b) => a+b,0)/times.length, cycleMaxMs: Math.max(...times) });
  } else {
    const db = new DatabaseSync(workerData.path, { readOnly: true });
    db.exec(`CREATE TEMP VIEW facts AS SELECT * FROM main.facts WHERE NOT (
      kind = 'relation.created' AND coalesce(json_extract(payload, '$.evidence.agentType'), '') = 'codex-exec')`);
    db.exec('PRAGMA query_only = ON');
    const additions: unknown[] = [];
    const ledger = { append(input: unknown) { additions.push(input); return { status: 'appended', seq: 0 }; } } as Ledger;
    const baselinePath = '../../src/observe/direct-codex-baseline.ts';
    const createObserver = process.env.DIRECT_CODEX_BASELINE ? (await import(baselinePath)).createDirectCodexObserver : createDirectCodexObserver;
    const observer = createObserver(ledger, db);
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const paths = [...rolloutReader.list(join(codexHome, 'sessions')), ...rolloutReader.list(join(codexHome, 'archived_sessions'))];
    const pathSet = new Set(paths);
    const open = fs.openSync;
    let prefixOpens = 0;
    fs.openSync = (...args) => { if (pathSet.has(String(args[0]))) prefixOpens++; return open(...args); };
    syncBuiltinESMExports();
    const beforeHeap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const rows = process.env.DIRECT_CODEX_BASELINE ? db.prepare(`SELECT * FROM facts f WHERE seq > ? AND seq <= ? AND (
      kind LIKE 'conversation.%' OR kind LIKE 'relation.%' OR source = 'transcript-claude' AND (
      kind = 'message.created' AND instr(payload, 'codex exec') > 0 OR kind = 'message_membership.created' AND EXISTS (
      SELECT 1 FROM facts m WHERE m.subject = 'message:' || json_extract(f.payload, '$.message_id')
      AND m.kind = 'message.created' AND m.source = 'transcript-claude' AND instr(m.payload, 'codex exec') > 0))) ORDER BY seq`) : prepareDirectFacts(db);
    function* facts() { for (const row of rows.iterate(0, Number.MAX_SAFE_INTEGER)) yield { ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact; }
    const initial = observer(process.env.DIRECT_CODEX_BASELINE ? [...facts()] : facts(), paths);
    const startupPrefixOpens = prefixOpens;
    prefixOpens = 0;
    const startupMs = performance.now()-started;
    const startupHeap = process.memoryUsage().heapUsed;
    for (let i=0;i<CYCLES;i++) {
      await delay(1000);
      const start = performance.now(); observer([], paths); times.push(performance.now()-start);
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }
    parentPort!.postMessage({ mode: 'direct', paths: paths.length, initial, additions: additions.length,
      matchDigest: createHash('sha256').update(additions.map(value => String((value as { source_event_id: string }).source_event_id)).sort().join('\n')).digest('hex'),
      startupPrefixOpens, idlePrefixOpens: prefixOpens, beforeHeap, startupHeap, startupMs, heapPeak,
      cycleMeanMs: times.reduce((a,b)=>a+b,0)/times.length, cycleMaxMs: Math.max(...times) });
    fs.openSync = open; syncBuiltinESMExports();
    db.close();
  }
}
