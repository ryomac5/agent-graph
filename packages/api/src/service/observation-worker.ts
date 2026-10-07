import { parentPort, workerData } from "node:worker_threads";
import { startHookServer } from "../hook/index.ts";
import { openObservationService, OBSERVATION_POLL_MS, type ObservationOptions } from "./index.ts";
import { pollObservation } from "./poll.ts";

const port = parentPort!;
const { observe, hook: enableHook = true, ...options } = workerData as ObservationOptions & { observe: boolean; hook?: boolean };
let progressTime = 0;
const service = openObservationService({ ...options, writerOnly: true, onProgress(progress) {
  if (progress.processed === 0 || progress.processed === progress.total || performance.now() - progressTime >= 50) {
    progressTime = performance.now();
    port.postMessage({ type: "progress", ...progress });
  }
} });
const append = service.ledger.append;
service.ledger.append = (input) => {
  const result = append(input);
  if (input.source === "hook" && result.status === "appended") port.postMessage({ type: "appended", seq: result.seq });
  return result;
};
const hook = enableHook ? await startHookServer(service.ledger, 0) : undefined;
port.postMessage({ type: "ready", hook: { url: hook?.url ?? "", token: hook?.token ?? "" } });
let timer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let started = false;
function ingest(): void {
  port.postMessage({ type: "started" });
  try {
    const report = pollObservation(() => service.ingestOnce());
    port.postMessage({ type: "complete", report, seq: service.lastSeq() });
    // 前の周期の投影も書き戻す。WAL の整理は通知の後に書き手だけが行う。
    if (report) pollObservation(() => service.checkpoint());
  } catch (error) {
    port.postMessage({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
    return;
  }
  // 次の走査は前の走査の完了後に予約する。
  if (!stopped) timer = setTimeout(ingest, OBSERVATION_POLL_MS);
}
port.on("message", async (message) => {
  if (message === "start" && observe && !started) { started = true; ingest(); }
  if (message === "stop") {
    stopped = true;
    clearTimeout(timer);
    await hook?.close();
    service.close();
    port.close();
  }
});
