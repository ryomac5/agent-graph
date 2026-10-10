import { DatabaseSync, StatementSync, type SQLInputValue } from "node:sqlite";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openObservationService } from "../../src/service/index.ts";
import { acquirePerformanceLock } from "./perf-lock.ts";
import { ProjectionFeed } from "../../src/service/projection-feed.ts";

// realdata.test.ts の build モードで作った台帳を渡す。--active は合成会話を一時的に running にする。
const WAIT_MS = 65_000;
const statements = new WeakMap<StatementSync, { db: DatabaseSync; sql: string }>();
const connections = new Map<DatabaseSync, number>();
const counts = new Map<string, { sql: string; connection: number; calls: number; rows: number; db: DatabaseSync; args: SQLInputValue[] }>();
let recording = false;
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  if (!connections.has(this)) connections.set(this, connections.size + 1);
  const statement = prepare.call(this, sql);
  statements.set(statement, { db: this, sql });
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (recording) for (const statement of sql.split(";").map(value => value.trim()).filter(Boolean)) {
    const key = `${connections.get(this)}:${statement}`;
    const count = counts.get(key) ?? { sql: statement, connection: connections.get(this)!, calls: 0, rows: 0, db: this, args: [] };
    count.calls++;
    counts.set(key, count);
  }
  return exec.call(this, sql);
};
for (const method of ["all", "get", "iterate", "run"] as const) {
  const execute = StatementSync.prototype[method];
  Object.defineProperty(StatementSync.prototype, method, { value: function (...args: never[]) {
    const info = statements.get(this);
    if (!info) return Reflect.apply(execute, this, args);
    const key = `${connections.get(info.db)}:${info.sql}`;
    let count = recording ? counts.get(key) : undefined;
    if (recording && !count) {
      count = { ...info, connection: connections.get(info.db)!, calls: 0, rows: 0, args };
      counts.set(key, count);
    }
    if (count) count.calls++;
    const result = Reflect.apply(execute, this, args);
    if (method === "iterate" && count) {
      return (function* () { for (const row of result) { count!.rows++; yield row; } })();
    }
    if (count) count.rows += method === "all" ? result.length : method === "get" ? Number(!!result) : 0;
    return result;
  } });
}
function report() {
  recording = false;
  return [...counts.values()].map(({ db, args, ...count }) => ({ ...count,
    plan: /^SELECT/i.test(count.sql.trim()) ? prepare.call(db, `EXPLAIN QUERY PLAN ${count.sql}`).all(...args).map(row => row.detail) : [],
  }));
}
if (isMainThread) {
  const release = await acquirePerformanceLock();
  const path = process.argv[2];
  let restore = () => {};
  if (process.argv.includes("--active")) {
    const db = new DatabaseSync(path);
    const row = db.prepare(`SELECT r.id, r.state, r.last_evidence_ts FROM runs r JOIN conversations c ON c.id = r.conversation_id
      WHERE c.provider = 'codex' AND c.native_id = 'conversation-0'`).get();
    if (!row) throw new Error("Expected the realdata.test.ts fixture conversation");
    db.prepare("UPDATE runs SET state = 'running', last_evidence_ts = ? WHERE id = ?").run(new Date().toISOString(), row.id!);
    db.close();
    restore = () => {
      const connection = new DatabaseSync(path);
      connection.prepare("UPDATE runs SET state = ?, last_evidence_ts = ? WHERE id = ?").run(row.state!, row.last_evidence_ts!, row.id!);
      connection.close();
    };
  }
  const home = join(dirname(path), "idle-probe-home");
  mkdirSync(home, { recursive: true });
  const service = openObservationService({ dbPath: path, home, env: { HOME: home }, readerOnly: true });
  const feed = new ProjectionFeed(path, service.catchUp);
  const worker = new Worker(new URL(import.meta.url), { workerData: { path, home }, execArgv: [] });
  const ready = await new Promise<NodeJS.MemoryUsage>(resolve => worker.once("message", resolve));
  feed.snapshot();
  let after = "";
  do { after = String(feed.list("conversations", after).next ?? ""); } while (after);
  const loaded = process.memoryUsage();
  let peak = loaded.rss;
  recording = true;
  worker.postMessage("measure");
  const timer = setInterval(() => { feed.refresh(); peak = Math.max(peak, process.memoryUsage().rss); }, 500);
  const measured = await new Promise(resolve => worker.once("message", resolve));
  clearInterval(timer);
  process.stdout.write(JSON.stringify({ loaded, peak, delta: peak - loaded.rss, ready, main: report(), worker: measured }) + "\n");
  await new Promise(resolve => worker.once("exit", resolve));
  feed.close(); service.close();
  restore();
  await release();
} else {
  const { path, home } = workerData;
  const service = openObservationService({ dbPath: path, home, env: { HOME: home }, writerOnly: true,
    codexProcessReader: { listProcesses: () => "", readOpenFiles: () => "" } });
  service.ingestOnce(); service.checkpoint();
  parentPort!.postMessage(process.memoryUsage());
  await new Promise(resolve => parentPort!.once("message", resolve));
  recording = true;
  const loaded = process.memoryUsage();
  let peak = loaded.rss;
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await delay(1000);
    service.ingestOnce(); service.checkpoint();
    peak = Math.max(peak, process.memoryUsage().rss);
  }
  parentPort!.postMessage({ loaded, peak, end: process.memoryUsage(), sql: report() });
  service.close(); parentPort!.close();
}
