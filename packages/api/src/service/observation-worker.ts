import { parentPort, workerData } from "node:worker_threads";
import { startHookServer } from "../hook/index.ts";
import { openObservationService, OBSERVATION_POLL_MS, PROJECTION_POLL_MS, type ObservationOptions } from "./index.ts";
import { pollObservation } from "./poll.ts";

import { createHistoryWatch } from "./history-watch.ts";
import { fileReadMetrics } from "../observe/files.ts";
import { createCheckpointSchedule } from "./checkpoint-schedule.ts";
import { repairTimestampsOnStartup } from "./repair-timestamps.ts";

const port = parentPort!;
const { observe, hook: enableHook = true, measureMemory, ...options } = workerData as ObservationOptions & { observe: boolean; hook?: boolean; measureMemory?: boolean };
const shouldCheckpoint = createCheckpointSchedule(OBSERVATION_POLL_MS);
let watchCycle = false;
const PROJECTION_RETRY_MS = 25;
let progressTime = 0;
const service = openObservationService({ ...options, writerOnly: true, projectInWorker: true, onProgress(progress) {
  if (!watchCycle && (progress.processed === 0 || progress.processed === progress.total || performance.now() - progressTime >= 50)) {
    progressTime = performance.now();
    port.postMessage({ type: "progress", ...progress });
  }
} });
const append = service.ledger.append;
service.ledger.append = (input) => {
  const result = append(input);
  if (input.source === "hook" && result.status === "appended") {
    port.postMessage({ type: "appended", seq: result.seq });
    scheduleProjection();
  }
  return result;
};
const hook = enableHook ? await startHookServer(service.ledger, 0) : undefined;
port.postMessage({ type: "ready", hook: { url: hook?.url ?? "", token: hook?.token ?? "" } });
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let started = false;
let projectionTimer: ReturnType<typeof setImmediate> | undefined;
let projectionRetry: ReturnType<typeof setTimeout> | undefined;
function scheduleProjection(): void {
  if (stopped || projectionTimer || projectionRetry || service.projectionSeq() === service.lastSeq()) return;
  projectionTimer = setImmediate(() => {
    projectionTimer = undefined;
    try {
      const before = service.projectionSeq();
      const state = service.catchUp();
      if (state.last_seq > before) port.postMessage({ type: "projected", seq: state.last_seq });
      scheduleProjection();
    } catch (error) {
      if (error instanceof Error && "errcode" in error && Number(error.errcode) === 5) {
        projectionRetry = setTimeout(() => { projectionRetry = undefined; scheduleProjection(); }, PROJECTION_RETRY_MS);
        return;
      }
      port.postMessage({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    }
  });
}
function checkpoint(): void {
  if (stopped) return;
  if (shouldCheckpoint(service.lastSeq(), service.projectionSeq(), performance.now())) {
    pollObservation(() => service.checkpoint());
  }
}
const projectionPoll = setInterval(() => { scheduleProjection(); checkpoint(); }, PROJECTION_POLL_MS);
let watchedPaths: string[] = [];
const historyWatch = createHistoryWatch((paths) => {
  if (!started || stopped) return;
  ingest(paths);
});
function ingest(paths?: ReadonlySet<string>): void {
  if (!paths) timer = undefined;
  watchCycle = !!paths;
  if (!paths) port.postMessage({ type: "started" });
  try {
    const reads = measureMemory ? { ...fileReadMetrics } : undefined;
    const report = pollObservation(() => paths ? service.ingestChanged(paths) : service.ingestOnce());
    port.postMessage({ type: paths ? "watched" : "complete", report, seq: service.lastSeq(), memory: measureMemory ? process.memoryUsage() : undefined,
      activity: reads ? { watch: !!paths, opened: fileReadMetrics.opened - reads.opened,
        contentBytes: fileReadMetrics.contentBytes - reads.contentBytes } : undefined });
    if (!paths) watchedPaths = service.watchPaths();
    historyWatch.update(watchedPaths);
    scheduleProjection();
    // 投影と配信の更新が落ち着いてから整理する。
    checkpoint();
  } catch (error) {
    port.postMessage({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  watchCycle = false;
  // 次の走査は前の走査の完了後に予約する。
  if (!stopped && !paths) timer = setTimeout(ingest, OBSERVATION_POLL_MS);
}
port.on("message", async (message) => {
  if (message?.type === "append") {
    try {
      if (stopped) throw new Error("Observation worker stopped");
      if (message.input?.source !== "ui") throw new Error("Only ui facts may be appended from the main thread");
      const result = service.ledger.append(message.input);
      if (result.status === "appended") scheduleProjection();
      port.postMessage({ type: "append-result", id: message.id, result });
    } catch (error) {
      port.postMessage({ type: "append-error", id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (message === "start" && !started) {
    started = true;
    try {
      const result = repairTimestampsOnStartup(service.dbPath);
      port.postMessage({ type: "timestamps-repaired", ...result });
      port.postMessage({ type: "projected", seq: service.projectionSeq() });
    } catch (error) {
      // 補完失敗は配信・投影を止めない。完了印がないため次回起動で再試行する。
      port.postMessage({ type: "timestamp-repair-failed", message: error instanceof Error ? error.message : String(error) });
    }
    if (observe) ingest();
  }
  if (message === "stop") {
    stopped = true;
    clearTimeout(timer);
    historyWatch.close();
    clearInterval(projectionPoll);
    clearImmediate(projectionTimer);
    clearTimeout(projectionRetry);
    await hook?.close();
    service.close();
    port.close();
  }
});
