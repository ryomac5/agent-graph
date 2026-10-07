import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyIncremental, rebuild } from "../../../core/src/ledger/index.ts";
import type { Fact, FactInput, Ledger } from "../../../core/src/ledger/index.ts";
import { createHookFacts, parseHookEvent } from "../hook/index.ts";
import type { HookEvent } from "../hook/index.ts";
import { observeClaudeHistories } from "./claude-reader.ts";
import { observeCodex } from "../observe/codex/index.ts";
import { createKitObserver } from "../observe/kit/index.ts";
import { hookOutboxPath, ledgerDbPath } from "../paths.ts";
import { createIncrementalRolloutReader, createRolloutContext } from "./codex-reader.ts";
import { createDirectoryReader } from "../observe/directories.ts";
import type { FileCursor } from "../observe/files.ts";
import type { RolloutCheckpoint } from "./codex-reader.ts";
import { openBatchLedger } from "./batch-ledger.ts";
import { openReadLedger } from "./read-ledger.ts";
import { rebuildInitialProjection } from "./initial-projection.ts";

const PROJECTION_CACHE_KIB = 128 * 1024;
const PROJECTION_BATCH_FACTS = 8;
const SNAPSHOT_READ_FACTS = 1024;
const INITIAL_PROJECTION_FACTS = 4096;
export const PROJECTION_POLL_MS = 500;
export const OBSERVATION_POLL_MS = 1000;
export interface ObservationOptions {
  dbPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  live?: boolean;
  writerOnly?: boolean;
  readerOnly?: boolean;
  onProgress?: (progress: { processed: number; total: number }) => void;
}
export interface IngestionReport {
  appended: number;
  unsupported: number;
  pending: number;
  deferred: number;
}
export interface ObservationProgress {
  state: "idle" | "running" | "failed";
  processed?: number;
  total?: number;
  report?: IngestionReport;
  seq?: number;
}

function ingestOutbox(ledger: Ledger, paths: string[], batch: <T>(operation: () => T) => T): void {
  if (paths.length === 0) return;
  const conversations = new Set(ledger.readSince(0, Number.MAX_SAFE_INTEGER)
    .filter((fact) => fact.kind === "conversation.created").map((fact) => fact.subject));
  for (const path of paths) {
    let body: string;
    try { body = readFileSync(path, "utf8"); }
    catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    let event: HookEvent;
    try { event = parseHookEvent(JSON.parse(body)); }
    catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      // 元の送信待ちは残し、同じ内容の未対応記録を増やさない。本文は保存しない。
      const id = JSON.stringify(["unsupported-hook", path, createHash("sha256").update(body).digest("hex")]);
      const result = ledger.append({ source: "hook", source_event_id: id,
        kind: "observation.unsupported", subject: `observation:${id}`, source_ts: new Date().toISOString(),
        confidence: "confirmed", payload: { source_kind: "hook", file_path: path,
          format_name: "hook-json", format_version: "unknown", reason: "Invalid hook event" } });
      if (result.status === "conflict") throw new Error(`Conflicting unsupported hook record: ${path}`);
      continue;
    }
    batch(() => {
      for (const fact of createHookFacts(event)) {
        if (fact.kind === "conversation.created" && conversations.has(fact.subject)) continue;
        const result = ledger.append(fact);
        if (result.status === "conflict") throw new Error(`Conflicting hook event: ${event.event_id}`);
        if (fact.kind === "conversation.created") conversations.add(fact.subject);
      }
    });
    // 耐久の追記が完了してから送信待ちを消す。応答喪失による再送も台帳で識別する。
    try { unlinkSync(path); }
    catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function openObservationService(options: ObservationOptions = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const dbPath = options.dbPath ?? ledgerDbPath(env, home);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const buffered = options.readerOnly ? openReadLedger(dbPath) : openBatchLedger(dbPath);
  const ledger = buffered.ledger;
  const projectionDb = new DatabaseSync(dbPath);
  projectionDb.exec(`PRAGMA busy_timeout = ${options.readerOnly ? 0 : 5000}; PRAGMA cache_size = -${PROJECTION_CACHE_KIB}`);
  // 再構築できる投影は WAL にまとめ、耐久台帳の fsync と checkpoint は書き手が担う。
  projectionDb.exec("PRAGMA synchronous = NORMAL; PRAGMA wal_autocheckpoint = 0; PRAGMA temp_store = MEMORY");
  const readLastSeq = projectionDb.prepare("SELECT max(seq) AS seq FROM facts");
  const readProjectionState = projectionDb.prepare("SELECT last_seq, generation FROM projection_state WHERE id = 1");
  const readSnapshot = projectionDb.prepare(`SELECT * FROM facts WHERE seq > ? AND seq <= ?
    AND kind NOT LIKE 'message_membership.%'
    AND (kind NOT LIKE 'message.%' OR subject LIKE '%history-unavailable%') ORDER BY seq LIMIT ?`);
  const countAdded = projectionDb.prepare(`SELECT count(*) AS appended,
    coalesce(sum(kind = 'observation.unsupported'), 0) AS unsupported FROM facts WHERE seq > ?`);
  let projectedSeq = Number(projectionDb.prepare("SELECT last_seq FROM projection_state WHERE id = 1").get()!.last_seq);
  let publishedSeq = projectedSeq;
  let generation = Number(projectionDb.prepare("SELECT generation FROM projection_state WHERE id = 1").get()!.generation);
  let observation: ObservationProgress = { state: "idle" };
  let projectionTimer: ReturnType<typeof setImmediate> | undefined;
  // 主スレッドの投影は小さな範囲に区切り、HTTP の間に処理できるようにする。
  const projectionConnection = options.readerOnly ? new Proxy(projectionDb, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(sql === "SELECT * FROM facts WHERE seq > ? ORDER BY seq"
      ? `${sql} LIMIT ${PROJECTION_BATCH_FACTS}` : sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) : projectionDb;
  function applyProjection() {
    if (!options.writerOnly) {
      const stored = readProjectionState.get()!;
      if (Number(stored.generation) !== generation) {
        generation = Number(stored.generation);
        projectedSeq = Number(stored.last_seq);
        publishedSeq = projectedSeq;
      }
    }
    if (options.writerOnly || observation.state === "running"
      || projectedSeq === Number(readLastSeq.get()!.seq ?? 0)) {
      return { last_seq: projectedSeq, generation, observation };
    }
    let state;
    try {
      // 空の投影には既存の依存先がない。初回の同期取り込みは純粋な全体投影で作る。
      state = !options.readerOnly && projectedSeq === 0 && Number(readLastSeq.get()!.seq ?? 0) >= INITIAL_PROJECTION_FACTS
        ? rebuildInitialProjection(projectionDb) : applyIncremental(projectionConnection, projectedSeq);
    }
    catch (error) {
      if (options.readerOnly && error instanceof Error && "errcode" in error && Number(error.errcode) === 5) {
        return { last_seq: projectedSeq, generation, observation };
      }
      throw error;
    }
    projectedSeq = state.last_seq;
    generation = state.generation;
    // 投影の小分けごとに画面の全表を読むのを避け、一巡の完了だけを公開する。
    if (!options.readerOnly || projectedSeq === Number(readLastSeq.get()!.seq ?? 0)) publishedSeq = projectedSeq;
    if (options.readerOnly && projectedSeq < Number(readLastSeq.get()!.seq ?? 0)) scheduleProjection();
    return { ...state, observation };
  }
  function catchUp() {
    // HTTP と WebSocket は確定済みの投影を読む。反映は要求の外で進める。
    if (options.readerOnly) {
      scheduleProjection();
      return { last_seq: publishedSeq, generation, observation };
    }
    return applyProjection();
  }
  if (!options.writerOnly) catchUp();
  function scheduleProjection(): void {
    if (!options.readerOnly || projectionTimer || observation.state === "running"
      || projectedSeq === Number(readLastSeq.get()!.seq ?? 0)) return;
    projectionTimer = setImmediate(() => {
      projectionTimer = undefined;
      if (observation.state === "running") return;
      const before = projectedSeq;
      applyProjection();
      if (projectedSeq > before && projectedSeq < Number(readLastSeq.get()!.seq ?? 0)) scheduleProjection();
    });
  }
  scheduleProjection();
  let decorate = (input: FactInput): FactInput => input;
  const projectedLedger: Ledger = { ...ledger, append(input) {
    if (options.readerOnly) throw new Error("Ledger writes belong to the observation worker");
    return ledger.append(decorate(input));
  } };
  const snapshot: Fact[] = [];
  let snapshotSeq = 0;
  function refreshSnapshot(): void {
    const throughSeq = Number(readLastSeq.get()!.seq ?? 0);
    if (snapshotSeq === throughSeq) return;
    for (;;) {
      // 観測の文脈に不要な本文を SQLite で除き、読み出してから捨てる処理を避ける。
      const added = readSnapshot.all(snapshotSeq, throughSeq, SNAPSHOT_READ_FACTS);
      for (const row of added) {
        snapshot.push({ ...row, payload: row.payload === null ? null : JSON.parse(String(row.payload)) } as Fact);
      }
      snapshotSeq = Number(added.at(-1)?.seq ?? snapshotSeq);
      if (added.length < SNAPSHOT_READ_FACTS) { snapshotSeq = throughSeq; break; }
    }
  }
  const scanLedger: Ledger = { ...projectedLedger,
    append: (input) => projectedLedger.append(input),
    readSince: (seq, limit) => seq === 0 && limit === Number.MAX_SAFE_INTEGER ? snapshot : ledger.readSince(seq, limit),
  };
  projectionDb.exec("CREATE TABLE IF NOT EXISTS api_observation_cursors (path TEXT PRIMARY KEY, state TEXT NOT NULL)");
  const checkpoints = new Map<string, FileCursor>();
  const rollouts = new Map<string, RolloutCheckpoint>();
  if (!options.readerOnly) {
    for (const row of projectionDb.prepare("SELECT path, state FROM api_observation_cursors").all()) {
      const state = JSON.parse(String(row.state));
      checkpoints.set(String(row.path), state.cursor);
      if (state.context) rollouts.set(String(row.path), state);
    }
    // 旧台帳の所属に載った cursor も、本文を取り出さずに引き継ぐ。
    for (const row of projectionDb.prepare(`SELECT cursor FROM facts WHERE seq IN (
      SELECT max(seq) FROM facts WHERE source IN ('transcript-claude', 'kit') AND cursor IS NOT NULL
      GROUP BY json_extract(cursor, '$.path'))`).iterate()) {
      const cursor = JSON.parse(String(row.cursor)) as FileCursor;
      if (cursor.path && !checkpoints.has(cursor.path)) checkpoints.set(cursor.path, cursor);
    }
  }
  const saveCheckpoint = projectionDb.prepare("INSERT OR REPLACE INTO api_observation_cursors VALUES (?, ?)");
  const list = createDirectoryReader();
  const listOutbox = createDirectoryReader(false);
  const kit = createKitObserver(scanLedger, checkpoints, refreshSnapshot);
  let rollout: ReturnType<typeof createIncrementalRolloutReader> | undefined;
  function hasChanged(path: string): boolean {
    let stat;
    try { stat = statSync(path); }
    catch (error) {
      // 走査後の archive・削除は、他の会話の取り込みを妨げない。
      if (isMissingFile(error)) return false;
      throw error;
    }
    const previous = checkpoints.get(path);
    return !previous || previous.identity !== `${stat.dev}:${stat.ino}` || previous.size !== stat.size
      || previous.mtimeMs !== stat.mtimeMs || previous.ctimeMs !== stat.ctimeMs;
  }
  let ingesting = false;
  return {
    ledger: projectedLedger, dbPath, outbox: hookOutboxPath(env, home), catchUp, batch: buffered.batch,
    checkpoint: buffered.checkpoint,
    setObservation(progress: ObservationProgress) { observation = { ...observation, ...progress }; scheduleProjection(); },
    getObservation() { return observation; },
    lastSeq() { return Number(readLastSeq.get()!.seq ?? 0); },
    notifyAppend(seq: number) { observation = { ...observation, seq }; scheduleProjection(); },
    rebuild() { const state = rebuild(projectionDb); projectedSeq = state.last_seq; publishedSeq = state.last_seq; generation = state.generation; return state; },
    ingestOnce(): IngestionReport {
      if (options.readerOnly) throw new Error("Observation belongs to the worker");
      if (ingesting) throw new Error("Observation already running");
      ingesting = true;
      const previousCheckpoints = new Map(checkpoints);
      try {
        refreshSnapshot();
        const codex = rollout ??= createIncrementalRolloutReader(scanLedger, rollouts);
        decorate = codex.decorate;
        const start = Number(readLastSeq.get()!.seq ?? 0);
        const claudeProjects = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
        const claudePaths = list(claudeProjects, (name) => name.endsWith(".jsonl")).filter(hasChanged);
        const codexHome = env.CODEX_HOME ?? join(home, ".codex");
        const codexPaths = new Set([...codex.reader.list(join(codexHome, "sessions")),
          ...codex.reader.list(join(codexHome, "archived_sessions"))].filter(hasChanged));
        let processed = 0;
        const total = claudePaths.length + codexPaths.size;
        options.onProgress?.({ processed, total });
        const trackBatch = <T>(operation: () => T): T => {
          const result = buffered.batch(operation);
          options.onProgress?.({ processed: ++processed, total });
          return result;
        };
        try {
          if (total) buffered.batch(() => {
            if (claudePaths.length) {
              const observations = observeClaudeHistories(scanLedger, claudeProjects, snapshot, trackBatch, claudePaths, checkpoints);
              if (observations.some((result) => result.conflicts.length > 0)) throw new Error("Conflicting Claude history");
            }
            const results = codexPaths.size ? observeCodex(scanLedger,
              { codexHome, reader: codex.reader, paths: codexPaths, batch: trackBatch }) : [];
            if (results.some((result) => result.status === "conflict")) throw new Error("Conflicting Codex history");
          });
          codex.commit();
          for (const path of codexPaths) {
            const state = rollouts.get(path);
            if (state) checkpoints.set(path, state.cursor);
          }
        } catch (error) { codex.discard(); throw error; }
        refreshSnapshot();
        ingestOutbox(scanLedger, listOutbox(hookOutboxPath(env, home),
          (name) => !name.startsWith(".") && name.endsWith(".json")), buffered.batch);
        refreshSnapshot();
        const aliases = kit.observe();
        const changedCheckpoints = [...checkpoints].filter(([path, cursor]) => previousCheckpoints.get(path) !== cursor);
        if (changedCheckpoints.length) {
          projectionDb.exec("BEGIN IMMEDIATE");
          try {
            for (const [path, cursor] of changedCheckpoints) saveCheckpoint.run(path,
              JSON.stringify({ cursor, context: rollouts.has(path) ? createRolloutContext(rollouts.get(path)!.context) : undefined }));
            projectionDb.exec("COMMIT");
          } catch (error) { projectionDb.exec("ROLLBACK"); throw error; }
        }
        const added = countAdded.get(start)!;
        return { appended: Number(added.appended), unsupported: Number(added.unsupported),
          pending: aliases.pending, deferred: aliases.deferred };
      } catch (error) {
        checkpoints.clear();
        for (const [path, cursor] of previousCheckpoints) checkpoints.set(path, cursor);
        throw error;
      } finally {
        ingesting = false;
        refreshSnapshot();
        if (!options.writerOnly) catchUp();
      }
    },
    close() { clearImmediate(projectionTimer); projectionDb.close(); ledger.close(); },
  };
}
