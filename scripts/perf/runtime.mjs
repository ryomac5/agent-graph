import { copyFileSync, constants, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openObservationService, PROJECTION_POLL_MS } from '../../packages/api/src/service/index.ts';
import { startObservationWorker } from '../../packages/api/src/service/worker-client.ts';
import { ProjectionFeed } from '../../packages/api/src/service/projection-feed.ts';
import { PERF } from './baseline.mjs';

const DELIVERY_DEBOUNCE_MS = 25;

mkdirSync(PERF, { recursive: true });
const path = join(PERF, `runtime-${process.pid}.db`);
copyFileSync(join(PERF, 'ledger.db'), path, constants.COPYFILE_FICLONE);
const state = join(PERF, 'runtime-state');
mkdirSync(join(state, 'agent-graph/outbox'), { recursive: true });
const options = { dbPath: path, home: homedir(), env: { ...process.env, XDG_STATE_HOME: state } };
const memory = { baseline: process.memoryUsage() };
const service = openObservationService({ ...options, readerOnly: true });
memory.service = process.memoryUsage();
const feed = new ProjectionFeed(path, service.catchUp);
memory.feed = process.memoryUsage();
let deliveryTimer;
const unsubscribe = service.onProjection?.(() => {
  if (deliveryTimer) return;
  deliveryTimer = setTimeout(() => { deliveryTimer = undefined; feed.refresh(); }, DELIVERY_DEBOUNCE_MS);
});
const timer = setInterval(() => feed.refresh(), PROJECTION_POLL_MS);
const worker = await startObservationWorker(service, { ...options, hook: false, measureMemory: true });
try {
  worker.start();
  const deadline = performance.now() + 120_000;
  while (service.getObservation().state !== 'idle' || service.catchUp().last_seq !== service.lastSeq()) {
    if (performance.now() > deadline) throw new Error('Observation warmup timed out');
    await Promise.race([worker.failure, delay(25)]);
  }
  await delay(2000);
  memory.warmMain = process.memoryUsage();
  memory.warmWorker = worker.memoryUsage();
  const cpu = process.cpuUsage();
  const activityStart = worker.activity?.();
  const start = performance.now();
  const reports = [];
  for (let i = 0; i < 10; i++) {
    await Promise.race([worker.failure, delay(1000)]);
    reports.push(service.getObservation().report);
  }
  const wallMs = performance.now() - start;
  const usage = process.cpuUsage(cpu);
  memory.idleMain = process.memoryUsage();
  memory.idleWorker = worker.memoryUsage();
  const beforeGc = process.memoryUsage();
  if (globalThis.gc) globalThis.gc();
  memory.afterMainGc = process.memoryUsage();
  const activity = activityStart && Object.fromEntries(Object.entries(worker.activity()).map(([key, value]) => [key, value - activityStart[key]]));
  console.log(JSON.stringify({ activity, wallMs, cpuMs: (usage.user + usage.system) / 1000,
    reports, cpuPercentOneCore: (usage.user + usage.system) / (wallMs * 10), memory, beforeGc,
    note: 'RSS is shared by all isolates; heap and external are per isolate. Live histories are read only; writes are isolated.' }));
} finally {
  clearInterval(timer);
  clearTimeout(deliveryTimer);
  unsubscribe?.();
  await worker.close();
  feed.close();
  service.close();
}
