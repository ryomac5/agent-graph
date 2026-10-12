import { Worker } from "node:worker_threads";
import type { AppendResult } from "../../../core/src/ledger/index.ts";
import type { ObservationOptions, UiFactInput, openObservationService } from "./index.ts";

export async function startObservationWorker(service: ReturnType<typeof openObservationService>,
  options: ObservationOptions & { observe?: boolean; hook?: boolean; measureMemory?: boolean } = {}) {
  service.useWorkerProjection();
  const worker = new Worker(new URL("./observation-worker.ts", import.meta.url), {
    workerData: { ...options, dbPath: service.dbPath, observe: options.observe ?? true }, execArgv: [],
  });
  let stopped = false;
  let failureError: Error | undefined;
  let requestId = 0;
  const pending = new Map<number, { resolve: (result: AppendResult) => void; reject: (error: Error) => void }>();
  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  let memory: NodeJS.MemoryUsage | undefined;
  const activity = { polls: 0, watches: 0, opened: 0, contentBytes: 0 };
  let fail: (error: Error) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => { fail = (error) => {
    failureError = error;
    rejectPending(error);
    service.setObservation({ state: "failed" });
    reject(error);
  }; });
  // 起動処理の間に落ちても未処理の Promise rejection を作らない。
  void failure.catch(() => {});
  worker.on("error", fail);
  worker.on("exit", (code) => { if (!stopped) fail(new Error(`Observation worker exited: ${code}`)); });
  worker.on("message", (message) => {
    if (message.type === "append-result" || message.type === "append-error") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.type === "append-error") request.reject(new Error(message.message));
      else {
        if (message.result.status === "appended") service.notifyAppend(message.result.seq);
        request.resolve(message.result);
      }
    }
    if (message.type === "started") service.setObservation({ state: "running", processed: 0, total: 0 });
    if (message.type === "progress") service.setObservation({ state: "running", processed: message.processed, total: message.total });
    if (message.type === "complete") {
      memory = message.memory;
      if (message.activity) {
        activity[message.activity.watch ? "watches" : "polls"]++;
        activity.opened += message.activity.opened;
        activity.contentBytes += message.activity.contentBytes;
      }
      service.setObservation({ state: message.report ? "idle" : "failed", report: message.report, seq: message.seq });
    }
    if (message.type === "projected") service.notifyProjection();
    if (message.type === "appended") service.notifyAppend(message.seq);
    if (message.type === "fatal") fail(new Error(message.message));
  });
  let hook;
  try {
    hook = await Promise.race([failure, new Promise<{ url: string; token: string }>((resolve) => {
      worker.on("message", (message) => { if (message.type === "ready") resolve(message.hook); });
    })]);
  } catch (error) { stopped = true; await worker.terminate(); throw error; }
  function append(input: UiFactInput): Promise<AppendResult> {
    if (input.source !== "ui") return Promise.reject(new Error("Only ui facts may be appended from the main thread"));
    if (stopped || failureError) return Promise.reject(failureError ?? new Error("Observation worker stopped"));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ type: "append", id, input }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  service.setUiAppender(append);
  return { hook, failure, memoryUsage() { return memory; }, activity() { return { ...activity }; }, start() {
    if (options.observe !== false) service.setObservation({ state: "running", processed: 0, total: 0 });
    worker.postMessage("start");
  }, async close() {
    stopped = true;
    rejectPending(new Error("Observation worker stopped"));
    if (worker.threadId !== -1) worker.postMessage("stop");
    await new Promise<void>((resolve) => {
      if (worker.threadId === -1) resolve();
      else worker.once("exit", () => resolve());
    });
  } };
}
