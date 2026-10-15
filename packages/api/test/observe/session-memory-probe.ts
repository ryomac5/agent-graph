import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProjectionFeed } from "../../src/service/projection-feed.ts";
import { openObservationService } from "../../src/service/index.ts";

// realdata.test.ts の build モードで作った台帳を、通信なしの作業スレッドで比較する。
const WAIT_MS = 65_000;
if (isMainThread) {
  for (const disabled of [false, true]) {
    const worker = new Worker(new URL(import.meta.url), { workerData: { path: process.argv[2], disabled }, execArgv: [] });
    worker.on("message", result => process.stdout.write(JSON.stringify(result) + "\n"));
    await new Promise<void>((resolve, reject) => { worker.on("error", reject); worker.on("exit", code => code ? reject(new Error(`Worker exit: ${code}`)) : resolve()); });
  }
} else {
  const { path, disabled } = workerData;
  const home = join(dirname(path), disabled ? "sessions-disabled" : "sessions-enabled");
  const service = openObservationService({ dbPath: path, home, env: { HOME: home }, writerOnly: true });
  service.ingestOnce();
  const feed = new ProjectionFeed(path, service.catchUp);
  const loaded = process.memoryUsage();
  let heapTotal = 0;
  let heapUsed = 0;
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await delay(1000);
    service.ingestOnce();
    const at = Date.now();
    if (!disabled) feed.recordScan({ provider: 'codex', id: 'probe:' + at, at, status: 'succeeded', sessions: [], processes: [] });
    feed.refresh(at);
    const usage = process.memoryUsage();
    heapTotal = Math.max(heapTotal, usage.heapTotal);
    heapUsed = Math.max(heapUsed, usage.heapUsed);
  }
  parentPort!.postMessage({ disabled, loaded, idlePeak: { heapTotal, heapUsed } });
  feed.close(); service.close();
}
