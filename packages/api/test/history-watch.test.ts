import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createHistoryWatch, HISTORY_DEBOUNCE_MS } from "../src/service/history-watch.ts";
import { WATCH_FILE_LIMIT } from "../src/service/index.ts";

test("履歴監視は数に上限を設け、連続通知をまとめ、置換と停止で監視を解放する", async t => {
  const handles = new Map<string, EventEmitter & { closed: boolean; close(): void; change(event: string): void }>();
  t.mock.method(fs, "watch", (path: string, changed: (event: string) => void) => {
    const handle = Object.assign(new EventEmitter(), { closed: false,
      close() { this.closed = true; }, change: changed });
    handles.set(path, handle);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let cycles = 0;
  const watcher = createHistoryWatch(() => { cycles++; });
  t.after(() => watcher.close());
  const paths = Array.from({ length: WATCH_FILE_LIMIT + 10 }, (_, i) => `file-${i}`);
  watcher.update(paths);
  assert.equal(handles.size, WATCH_FILE_LIMIT);
  for (let i = 0; i < 10; i++) handles.get("file-0")!.change("change");
  await delay(HISTORY_DEBOUNCE_MS * 2);
  assert.equal(cycles, 1);
  const previous = handles.get("file-0")!;
  previous.change("rename");
  assert.equal(previous.closed, true);
  watcher.update(paths.slice(0, 1));
  assert.notEqual(handles.get("file-0"), previous);
  assert.ok([...handles].filter(([path]) => path !== "file-0").every(([, handle]) => handle.closed));
  watcher.close();
  await delay(HISTORY_DEBOUNCE_MS * 2);
  assert.equal(cycles, 1);
  assert.ok([...handles.values()].every(handle => handle.closed));
});

test("長いターンの履歴は更新が十分以上止まっていても監視し、idle の古い履歴は外す", async t => {
  const { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openObservationService } = await import("../src/service/index.ts");
  const home = mkdtempSync(join(tmpdir(), "api-watch-active-"));
  const directory = join(home, ".claude/projects/fixture");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "long.jsonl");
  const timestamp = new Date().toISOString();
  writeFileSync(path, JSON.stringify({ type: "user", uuid: "long", timestamp,
    message: { role: "user", content: "Long running request" } }) + "\n");
  const service = openObservationService({ home, env: { HOME: home }, dbPath: join(home, "ledger.db") });
  t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
  service.ingestOnce();
  utimesSync(path, new Date(0), new Date(0));
  service.ingestOnce();
  assert.ok(service.watchPaths().includes(path));
  const run = service.ledger.readSince(0, 100).find(fact => fact.kind === "run.created");
  assert.ok(run?.kind === "run.created" && run.payload);
  service.ledger.append({ source: "hook", source_event_id: "idle-long", kind: "run.state_changed", subject: run.subject,
    source_ts: new Date(Date.parse(timestamp) + 1000).toISOString(), confidence: "confirmed",
    payload: { conversation_id: String(run.payload.conversation_id), generation: Number(run.payload.generation), state: "idle" } });
  service.catchUp();
  assert.ok(!service.watchPaths().includes(path));
});
