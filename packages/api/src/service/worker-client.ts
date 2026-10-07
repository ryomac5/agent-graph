import { Worker } from "node:worker_threads";
import type { ObservationOptions, openObservationService } from "./index.ts";

export async function startObservationWorker(service: ReturnType<typeof openObservationService>,
  options: ObservationOptions & { observe?: boolean; hook?: boolean } = {}) {
  const worker = new Worker(new URL("./observation-worker.ts", import.meta.url), {
    workerData: { ...options, dbPath: service.dbPath, observe: options.observe ?? true }, execArgv: [],
  });
  let stopped = false;
  let fail: (error: Error) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => { fail = (error) => {
    service.setObservation({ state: "failed" });
    reject(error);
  }; });
  // 起動処理の間に落ちても未処理の Promise rejection を作らない。
  void failure.catch(() => {});
  worker.on("error", fail);
  worker.on("exit", (code) => { if (!stopped) fail(new Error(`Observation worker exited: ${code}`)); });
  worker.on("message", (message) => {
    if (message.type === "started") service.setObservation({ state: "running", processed: 0, total: 0 });
    if (message.type === "progress") service.setObservation({ state: "running", processed: message.processed, total: message.total });
    if (message.type === "complete") service.setObservation({ state: message.report ? "idle" : "failed", report: message.report, seq: message.seq });
    if (message.type === "appended") service.notifyAppend(message.seq);
    if (message.type === "fatal") fail(new Error(message.message));
  });
  let hook;
  try {
    hook = await Promise.race([failure, new Promise<{ url: string; token: string }>((resolve) => {
      worker.on("message", (message) => { if (message.type === "ready") resolve(message.hook); });
    })]);
  } catch (error) { stopped = true; await worker.terminate(); throw error; }
  return { hook, failure, start() {
    if (options.observe !== false) service.setObservation({ state: "running", processed: 0, total: 0 });
    worker.postMessage("start");
  }, async close() {
    stopped = true;
    if (worker.threadId !== -1) worker.postMessage("stop");
    await new Promise<void>((resolve) => {
      if (worker.threadId === -1) resolve();
      else worker.once("exit", () => resolve());
    });
  } };
}
