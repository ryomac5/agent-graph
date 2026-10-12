import { watch, type FSWatcher } from "node:fs";
import { WATCH_FILE_LIMIT } from "./index.ts";

export const HISTORY_DEBOUNCE_MS = 25;

/** 通知が欠けても見回りを続け、監視の失敗で観測を止めない。 */
export function createHistoryWatch(changed: (paths: ReadonlySet<string>) => void) {
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let pending = new Set<string>();
  function schedule(path: string): void {
    if (closed) return;
    pending.add(path);
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      const paths = pending;
      pending = new Set();
      changed(paths);
    }, HISTORY_DEBOUNCE_MS);
  }
  return {
    update(paths: string[]): void {
      const selected = new Set(paths.slice(0, WATCH_FILE_LIMIT));
      for (const [path, watcher] of watchers) if (!selected.has(path)) { watcher.close(); watchers.delete(path); }
      for (const path of selected) {
        if (watchers.has(path)) continue;
        try {
          const watcher = watch(path, (event) => {
            schedule(path);
            if (event === "rename") { watcher.close(); watchers.delete(path); }
          });
          watcher.on("error", () => { watcher.close(); watchers.delete(path); });
          watchers.set(path, watcher);
        } catch (error) {
          if (!(error instanceof Error && "code" in error
            && ["ENOENT", "ENOSPC", "EMFILE", "ENFILE", "EPERM", "EACCES"].includes(String(error.code)))) throw error;
        }
      }
    },
    close(): void {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      pending.clear();
    },
  };
}
