import { registerHooks } from 'node:module';
import { readFileSync, copyFileSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PERF, REPEATS, summarize } from './baseline.mjs';

// 測定用プロセスのメモリ上だけに区間の境界を足す。
const markers = [
  ['const codex = rollout ??=', 'snapshot'],
  ['let processed = 0;', 'discovery'],
  ['if (codexLocations.length) {', 'history_and_titles'],
  ['const directThrough =', 'locations'],
  ['ingestOutbox(scanLedger,', 'direct_codex'],
  ['const aliases = kit.observe();', 'outbox'],
  ['remoteConversations = buffered.batch', 'kit'],
  ['if (existsSync(claudeSessionsDirectory))', 'remote_status'],
  ['buffered.batch(() => observeCodexSessions());', 'claude_sessions'],
  ['const changedCheckpoints =', 'codex_sessions'],
  ['const added = countAdded.get(start)!;', 'checkpoints'],
];
let stageStart;
let breakdown;
globalThis.__perfMark = name => {
  const now = performance.now();
  breakdown[name] = (breakdown[name] ?? 0) + now - stageStart;
  stageStart = now;
};
registerHooks({ load(url, context, next) {
  if (!url.endsWith('/packages/api/src/service/index.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8');
  const at = source.indexOf('ingestOnce(): IngestionReport {');
  let tail = source.slice(at);
  for (const [needle, name] of markers) {
    if (tail.split(needle).length !== 2) throw new Error(`Observation instrumentation drift: ${needle}`);
    tail = tail.replace(needle, `globalThis.__perfMark('${name}');\n${needle}`);
  }
  return { format: 'module-typescript', source: source.slice(0, at) + tail, shortCircuit: true };
} });
const { openObservationService } = await import('../../packages/api/src/service/index.ts');
const { fileReadMetrics } = await import('../../packages/api/src/observe/files.ts');
mkdirSync(PERF, { recursive: true });
const isolatedState = join(PERF, 'state');
mkdirSync(join(isolatedState, 'agent-graph/outbox'), { recursive: true });
const path = join(PERF, 'observation.db');
copyFileSync(join(PERF, 'ledger.db'), path, constants.COPYFILE_FICLONE);
const start = performance.now();
const service = openObservationService({ dbPath: path, home: homedir(), env: { ...process.env, XDG_STATE_HOME: isolatedState }, writerOnly: true });
const initializationMs = performance.now() - start;
const cycles = [];
try {
  for (let i = 0; i <= REPEATS; i++) {
    breakdown = {};
    const reads = { ...fileReadMetrics };
    const cpu = process.cpuUsage();
    const begin = performance.now(); stageStart = begin;
    const report = service.ingestOnce();
    globalThis.__perfMark('finish');
    const ms = performance.now() - begin;
    const usage = process.cpuUsage(cpu);
    cycles.push({ kind: i === 0 ? 'warmup' : 'steady', ms, breakdown, report, cpuMs: (usage.user + usage.system) / 1000, rssBytes: process.memoryUsage().rss, reads: Object.fromEntries(Object.keys(reads).map(key => [key, fileReadMetrics[key] - reads[key]])) });
    if (i < REPEATS) await delay(1000);
  }
} finally { service.close(); }
const steady = cycles.slice(1);
const idle = steady.filter(cycle => cycle.report.appended === 0 && cycle.reads.opened === 0);
const idleSummary = { time: summarize(idle.map(c => c.ms)), cpuMs: summarize(idle.map(c => c.cpuMs)), phases: Object.fromEntries(markers.map(([, name]) => [name, summarize(idle.map(c => c.breakdown[name]))])) };
const output = { initializationMs, initializationN: 1, idle: idleSummary, cycles, steady: summarize(steady.map(c => c.ms)), phases: Object.fromEntries(markers.map(([, name]) => [name, summarize(steady.map(c => c.breakdown[name]))])), cpuMs: summarize(steady.map(c => c.cpuMs)), rssBytes: summarize(steady.map(c => c.rssBytes)) };
console.log(JSON.stringify(output));
