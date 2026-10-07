import { mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// 同じ test runner の大規模測定同士が CPU とディスクを奪い合わないようにする。
export async function acquirePerformanceLock(): Promise<() => Promise<void>> {
  const path = join(tmpdir(), `agent-graph-api-perf-${process.ppid}`);
  for (;;) {
    try { await mkdir(path); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      await delay(25);
    }
  }
  return () => rmdir(path);
}
