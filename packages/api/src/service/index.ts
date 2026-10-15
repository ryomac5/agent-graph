import { CurrentState } from './current-state.ts';
import { expandNativeEvidence } from '../../../core/src/ledger/native-evidence.ts';
import { observeCodexTitles } from "../observe/codex/titles.ts";
import { readRemoteMetadata, observeRemoteStatus } from '../remote/observation.ts';
import { cacheRoot } from '../remote/index.ts';
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyIncremental, rebuild } from "../../../core/src/ledger/index.ts";
import type { AppendResult, Fact, FactInput, Ledger } from "../../../core/src/ledger/index.ts";
import { createHookFacts, parseHookEvent } from "../hook/index.ts";
import type { HookEvent } from "../hook/index.ts";
import { observeClaudeHistories } from "./claude-reader.ts";
import { codexLocationEventId, observeCodex, observeCodexLocations } from "../observe/codex/index.ts";
import { claudeConversationId, claudeLocationEventId } from "../observe/claude/context.ts";
import { claudeTitleBackfillEventId } from "../observe/claude/titles.ts";
import { CLAUDE_HISTORY_DETAILS_VERSION, CLAUDE_MESSAGE_FLAGS_VERSION, CLAUDE_QUEUED_COMMANDS_VERSION } from "../observe/claude/index.ts";
import { CODEX_HISTORY_DETAILS_VERSION } from "../observe/codex/index.ts";
import { registerLedgerDatabase } from "../../../core/src/ledger/repository.ts";
import { createLocationResolver } from "../observe/location.ts";
import { createKitObserver } from "../observe/kit/index.ts";
import { hookOutboxPath, ledgerDbPath } from "../paths.ts";
import { createIncrementalRolloutReader, createRolloutContext } from "./codex-reader.ts";
import { createDirectCodexObserver, prepareDirectFacts } from "../observe/direct-codex.ts";
import { createDirectoryReader } from "../observe/directories.ts";
import { readInode } from "../observe/files.ts";
import type { FileCursor } from "../observe/files.ts";
import type { RolloutCheckpoint } from "./codex-reader.ts";
import { openBatchLedger } from "./batch-ledger.ts";
import { openReadLedger } from "./read-ledger.ts";
import { rebuildInitialProjection } from "./initial-projection.ts";

const PROJECTION_CACHE_KIB = 64 * 1024;
const OBSERVATION_CONTEXT_CACHE_KIB = 4 * 1024;
const PROJECTION_BATCH_FACTS = 8;
const SNAPSHOT_READ_FACTS = 1024;
const INITIAL_PROJECTION_FACTS = 4096;
export const PROJECTION_POLL_MS = 500;
export const OBSERVATION_POLL_MS = 1000;
export const WATCH_FILE_LIMIT = 128;
const WATCH_ACTIVITY_MS = 10 * 60 * 1000;
export type UiFactInput = FactInput & { source: "ui" };
export type UiAppender = (input: UiFactInput) => AppendResult | Promise<AppendResult>;
export interface ObservationOptions {
  dbPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  live?: boolean;
  writerOnly?: boolean;
  readerOnly?: boolean;
  projectInWorker?: boolean;
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
  // worker は観測と投影を逐次反映し、大きなページキャッシュを持たせない。
  projectionDb.exec(`PRAGMA busy_timeout = ${options.readerOnly ? 0 : 5000};
    PRAGMA cache_size = -${options.writerOnly ? OBSERVATION_CONTEXT_CACHE_KIB : PROJECTION_CACHE_KIB}`);
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
  const projectionListeners = new Set<() => void>();
  let observation: ObservationProgress = { state: "idle" };
  let externalProjection = false;
  let projectionTimer: ReturnType<typeof setImmediate> | undefined;
  // 投影は小さな範囲に区切り、観測と UI の要求の間に反映する。
  const projectionConnection = options.readerOnly || options.projectInWorker ? new Proxy(projectionDb, { get(target, key) {
    if (key === "prepare") return (sql: string) => target.prepare(sql === "SELECT * FROM facts WHERE seq > ? ORDER BY seq"
      ? `${sql} LIMIT ${PROJECTION_BATCH_FACTS}` : sql);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) : projectionDb;
  function applyProjection() {
    if (!options.writerOnly || options.projectInWorker) {
      const stored = readProjectionState.get()!;
      if (Number(stored.generation) !== generation) {
        generation = Number(stored.generation);
        projectedSeq = Number(stored.last_seq);
        publishedSeq = projectedSeq;
      }
    }
    if ((options.writerOnly && !options.projectInWorker) || observation.state === "running"
      || projectedSeq === Number(readLastSeq.get()!.seq ?? 0)) {
      return { last_seq: projectedSeq, generation, observation };
    }
    let state;
    try {
      // 空の投影には既存の依存先がない。初回の同期取り込みは純粋な全体投影で作る。
      state = !options.readerOnly && !options.projectInWorker && projectedSeq === 0 && Number(readLastSeq.get()!.seq ?? 0) >= INITIAL_PROJECTION_FACTS
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
    // 配信は変更した行だけを読むため、各取引の反映位置をそのまま公開する。
    publishedSeq = projectedSeq;
    for (const listener of projectionListeners) listener();
    if (options.readerOnly && projectedSeq < Number(readLastSeq.get()!.seq ?? 0)) scheduleProjection();
    return { ...state, observation };
  }
  function catchUp() {
    // HTTP と WebSocket は確定済みの投影を読む。反映は要求の外で進める。
    if (options.readerOnly) {
      const stored = readProjectionState.get()!;
      if (externalProjection || Number(stored.generation) !== generation) {
        generation = Number(stored.generation);
        projectedSeq = Number(stored.last_seq);
        publishedSeq = projectedSeq;
      }
      scheduleProjection();
      return { last_seq: publishedSeq, generation, observation };
    }
    return applyProjection();
  }
  if (!options.writerOnly) catchUp();
  function scheduleProjection(): void {
    if (externalProjection || !options.readerOnly || projectionTimer || observation.state === "running"
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
  let captureConflict: ((input: FactInput) => void) | undefined;
  const projectedLedger: Ledger = { ...ledger, append(input) {
    if (options.readerOnly) throw new Error("Ledger writes belong to the observation worker");
    const result = ledger.append(decorate(input));
    if (result.status === 'conflict') captureConflict?.(input);
    return result;
  } };
  registerLedgerDatabase(projectedLedger, projectionDb);
  const snapshot: Fact[] = [];
  let snapshotSeq = 0;
  function refreshSnapshot(): void {
    const throughSeq = Number(readLastSeq.get()!.seq ?? 0);
    if (snapshotSeq === throughSeq) return;
    for (;;) {
      // 観測の文脈に不要な本文を SQLite で除き、読み出してから捨てる処理を避ける。
      const added = readSnapshot.all(snapshotSeq, throughSeq, SNAPSHOT_READ_FACTS);
      for (const row of added) {
        snapshot.push({ seq: Number(row.seq), fact_id: String(row.fact_id), source: row.source,
          source_event_id: String(row.source_event_id), kind: row.kind, subject: row.subject,
          payload: row.payload === null ? null : JSON.parse(String(row.payload)), payload_hash: String(row.payload_hash),
          source_ts: String(row.source_ts), observed_ts: String(row.observed_ts), schema_version: Number(row.schema_version),
          cursor: row.cursor, confidence: row.confidence, supersedes: row.supersedes } as Fact);
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
  const directCodex = createDirectCodexObserver(scanLedger, projectionDb);
  let directSeq = 0;
  let directFiles: string[] = [];
  let historyFiles = new Set<string>();
  let cachedClaudeFiles: string[] = [];
  let cachedCodexFiles: string[] = [];
  let cachedRemoteFiles: string[] = [];
  let watchPathsDirty = true;
  let watchProjectionSeq = -1;
  let watchExpires = 0;
  let selectedWatchPaths: string[] = [];
  let changedHistoryPaths: ReadonlySet<string> | undefined;
  const readDirectFacts = prepareDirectFacts(projectionDb);
  const readDirectLocations = projectionDb.prepare("SELECT 1 FROM facts WHERE seq > ? AND seq <= ? AND kind GLOB 'conversation.*' AND json_type(payload, '$.cwd') = 'text' LIMIT 1");
  let watchState: CurrentState | undefined;
  const list = createDirectoryReader();
  const listOutbox = createDirectoryReader(false);
  const kit = createKitObserver(scanLedger, checkpoints, refreshSnapshot);
  const claudeSessionsDirectory = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "sessions");

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
    return !previous || readInode(previous.identity) !== String(stat.ino) || previous.size !== stat.size
      || previous.mtimeMs !== stat.mtimeMs || previous.ctimeMs !== stat.ctimeMs;
  }
  // 場所とターンの根拠と題名をまだ読んでいない会話の記録は、変更がなくても一度だけ読み直す。
  const locate = createLocationResolver();
  const locatedEvents = new Set<string>();
  const titledConversations = new Set<string>();
  let locatedThrough = 0;
  const contextAttempted = new Set<string>();
  function readLocated(): Set<string> {
    for (; locatedThrough < snapshot.length; locatedThrough += 1) {
      const fact = snapshot[locatedThrough];
      if ((fact.kind === "conversation.created" || fact.kind === "conversation.updated" || fact.kind === "conversation.corrected")
        && (typeof fact.payload?.ai_title === "string" && fact.payload.ai_title.trim()
        || fact.source === "transcript-claude" && fact.source_event_id === claudeTitleBackfillEventId(fact.subject.slice("conversation:".length)))) {
        titledConversations.add(fact.subject);
      }
      if ((fact.source === "transcript-claude" || fact.source === "rollout-codex") && fact.kind === "conversation.updated"
        && fact.source_event_id.endsWith(":location")) locatedEvents.add(`${fact.source}:${fact.source_event_id}`);
    }
    return locatedEvents;
  }
  function needsClaudeContext(path: string): boolean {
    if (contextAttempted.has(path)) return false;
    contextAttempted.add(path);
    const id = claudeConversationId(path);
    const located = readLocated().has(`transcript-claude:${claudeLocationEventId(id)}`);
    return path.includes("/subagents/") || !located || !titledConversations.has(`conversation:${id}`);
  }
  function needsCodexLocation(path: string): boolean {
    const nativeId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(basename(path))?.[1];
    if (!nativeId || contextAttempted.has(path)) return false;
    contextAttempted.add(path);
    return !readLocated().has(`rollout-codex:${codexLocationEventId(nativeId)}`);
  }
  const checkedConflicts = new Set<string>();
  type HistoryConflict = Extract<Fact, { kind: 'observation.unsupported' }>;
  let historyConflicts = new Map<string, HistoryConflict[]>();
  let pendingConflicts = new Set<string>();
  // snapshot は追記だけなので、競合の記録と置き換えの id は前回の続きから読む。毎周期の全件走査で一時の割り当てを作らない。
  const historyConflictFacts: HistoryConflict[] = [];
  const supersededFacts = new Set<string>();
  let conflictsThrough = 0;
  function readHistoryConflicts(): Map<string, HistoryConflict[]> {
    for (; conflictsThrough < snapshot.length; conflictsThrough += 1) {
      const fact = snapshot[conflictsThrough];
      if (fact.supersedes) supersededFacts.add(fact.supersedes);
      if (fact.kind === 'observation.unsupported' && (String(fact.payload?.reason).startsWith('Conflicting history')
        || fact.payload?.reason === 'History conflict resolved by full reread')) historyConflictFacts.push(fact);
    }
    const byPath = new Map<string, HistoryConflict[]>();
    for (const fact of historyConflictFacts) if (!supersededFacts.has(fact.fact_id)) {
      const path = String(fact.payload?.file_path), group = byPath.get(path) ?? [];
      group.push(fact); byPath.set(path, group);
    }
    return byPath;
  }
  function observeFileBatch<T>(path: string, source: "rollout-codex" | "transcript-claude",
    operation: () => T, readRejected: (result: T) => AppendResult[], isComplete: (result: T) => boolean): T {
    const previous = historyConflicts.get(path) ?? [];
    const fullRead = pendingConflicts.has(path);
    const rows: { at: string; uuid?: string; offset?: number }[] = [];
    captureConflict = input => {
      for (const fact of expandNativeEvidence(input as Fact)) {
        const payload = fact.payload as Record<string, unknown>;
        const last = payload.last_evidence as Record<string, unknown> | undefined;
        const native = last?.native_record as Record<string, unknown> | undefined;
        const uuid = native?.uuid ?? (source === 'transcript-claude' && fact.kind.startsWith('message.') ? payload.native_id : undefined);
        const offset = source === 'rollout-codex' && fact.cursor ? JSON.parse(fact.cursor).offset : undefined;
        rows.push({ at: fact.source_ts, ...(typeof uuid === 'string' ? { uuid } : {}), ...(typeof offset === 'number' ? { offset } : {}) });
      }
    };
    let result: T;
    try { result = buffered.batch(operation); }
    finally { captureConflict = undefined; }
    const conflicts = readRejected(result);
    const locations = [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
    const reason = conflicts.length ? 'Conflicting history; existing facts retained' : 'History conflict resolved by full reread';
    // 差分の成功では古い競合を消さない。全件再読の結果でだけ置き換える。
    const reread = fullRead && isComplete(result);
    if (conflicts.length || reread) {
      const targets = reread ? previous : previous.filter(fact => fact.payload?.reason === 'History conflict resolved by full reread');
      for (const prior of targets.length ? targets : [undefined]) {
        if (prior && conflicts.length && JSON.stringify(prior.payload?.rows) === JSON.stringify(locations)
          && prior.payload?.count === conflicts.length) continue;
        const input = { source,
          source_event_id: JSON.stringify(['history-conflict', path, prior?.fact_id ?? null, locations, reason]),
          kind: 'observation.unsupported' as const, subject: `observation:history-conflict:${path}` as const,
          source_ts: new Date().toISOString(), confidence: 'confirmed' as const,
          ...(prior ? { supersedes: prior.fact_id } : {}),
          payload: { source_kind: source, file_path: path, format_name: 'jsonl', format_version: 'unknown',
            reason, count: conflicts.length, rows: locations } };
        const appended = ledger.append(input);
        checkedConflicts.add(appended.fact_id);
      }
      if (reread) for (const prior of previous) checkedConflicts.add(prior.fact_id);
    }
    return result;
  }
  let ingesting = false;
  let appendUi: UiAppender = (input) => projectedLedger.append(input);
  return {
    sessionDirectory: claudeSessionsDirectory,
    codexHome: env.CODEX_HOME ?? join(home, ".codex"),
    ledger: projectedLedger, dbPath, outbox: hookOutboxPath(env, home), catchUp, batch: buffered.batch,
    async appendUi(input: UiFactInput): Promise<AppendResult> {
      if (input.source !== "ui") throw new Error("Only ui facts may be appended from the main thread");
      return appendUi(input);
    },
    setUiAppender(append: UiAppender) { appendUi = append; },
    checkpoint: buffered.checkpoint,
    watchPaths() {
      if (!historyFiles.size) return [];
      const seq = Number(readProjectionState.get()?.last_seq ?? 0);
      if (!watchPathsDirty && seq === watchProjectionSeq && Date.now() < watchExpires) return selectedWatchPaths;
      watchPathsDirty = false;
      watchProjectionSeq = seq;
      watchExpires = Infinity;
      watchState ??= new CurrentState(projectionDb, id => {
        const row = projectionDb.prepare("SELECT id FROM conversations WHERE id = ? OR provider || ':' || native_id = ?").get(id, id);
        return String(row?.id ?? id);
      }, false);
      watchState.refresh(seq);
      watchExpires = watchState.reevaluateAt;
      const active = new Set([...watchState.conversations.values()].filter(row => ['running', 'waiting_approval', 'waiting_input'].includes(String(row.state)))
        .flatMap(row => {
          const c = projectionDb.prepare('SELECT provider, native_id FROM conversations WHERE id = ?').get(String(row.conversation_id));
          return c ? [`${c.provider}:${c.native_id}`] : [];
        }));
      const activePaths = new Set<string>();
      if (active.size) for (const path of historyFiles) {
        const meta = rollouts.get(path)?.context[0]?.value as { type?: string; id?: string; payload?: { id?: string } } | undefined;
        const nativeId = meta?.type === "session_meta" ? meta.payload?.id : meta?.id;
        const key = nativeId ? `codex:${nativeId}` : `claude:${basename(path, ".jsonl")}`;
        if (active.has(key)) activePaths.add(path);
      }
      selectedWatchPaths = [...checkpoints].filter(([path, cursor]) => historyFiles.has(path)
        && !path.includes("/archived_sessions/")
        && (activePaths.has(path) || (cursor.mtimeMs ?? 0) >= Date.now() - WATCH_ACTIVITY_MS))
        .sort((a, b) => Number(activePaths.has(b[0])) - Number(activePaths.has(a[0]))
          || (b[1].mtimeMs ?? 0) - (a[1].mtimeMs ?? 0)).slice(0, WATCH_FILE_LIMIT).map(([path, cursor]) => {
          if (!activePaths.has(path)) watchExpires = Math.min(watchExpires, (cursor.mtimeMs ?? 0) + WATCH_ACTIVITY_MS);
          return path;
        });
      return selectedWatchPaths;
    },
    useWorkerProjection() {
      if (!options.readerOnly) return;
      externalProjection = true;
      clearImmediate(projectionTimer);
      projectionTimer = undefined;
      projectionDb.exec(`PRAGMA cache_size = -${OBSERVATION_CONTEXT_CACHE_KIB}`);
    },
    notifyProjection() {
      catchUp();
      for (const listener of projectionListeners) listener();
    },
    onProjection(listener: () => void) {
      projectionListeners.add(listener);
      return () => { projectionListeners.delete(listener); };
    },
    setObservation(progress: ObservationProgress) { observation = { ...observation, ...progress }; scheduleProjection(); },
    getObservation() { return observation; },
    lastSeq() { return Number(readLastSeq.get()!.seq ?? 0); },
    projectionSeq() { return Number(readProjectionState.get()!.last_seq); },
    notifyAppend(seq: number) { observation = { ...observation, seq }; scheduleProjection(); },
    rebuild() { const state = rebuild(projectionDb); projectedSeq = state.last_seq; publishedSeq = state.last_seq; generation = state.generation; return state; },
    ingestChanged(paths: ReadonlySet<string>): IngestionReport {
      changedHistoryPaths = paths;
      try { return this.ingestOnce(); }
      finally { changedHistoryPaths = undefined; }
    },
    ingestOnce(): IngestionReport {
      if (options.readerOnly) throw new Error("Observation belongs to the worker");
      if (ingesting) throw new Error("Observation already running");
      ingesting = true;
      const previousCheckpoints = new Map(checkpoints);
      try {
        const changes = changedHistoryPaths;
        const fileChanges = new Map<string, boolean>();
        const readChanged = (path: string): boolean => {
          if (!fileChanges.has(path)) fileChanges.set(path, hasChanged(path));
          return fileChanges.get(path)!;
        };
        const start = Number(readLastSeq.get()!.seq ?? 0);
        if (!changes) ingestOutbox(scanLedger, listOutbox(hookOutboxPath(env, home),
          name => !name.startsWith(".") && name.endsWith(".json")), buffered.batch);
        refreshSnapshot();
        historyConflicts = readHistoryConflicts();
        pendingConflicts = new Set([...historyConflicts].filter(([path, facts]) => facts.some(fact => String(fact.payload?.reason).startsWith('Conflicting history')
          && (readChanged(path) || !checkedConflicts.has(fact.fact_id)))).map(([path]) => path));
        // 部品が開始 cursor を読む前に、対象ファイルだけ先頭へ戻す。
        for (const path of pendingConflicts) {
          const start = { path, identity: 'conflict-recheck', offset: 0, size: 0, hash: createHash('sha256').digest('hex') };
          checkpoints.set(path, start);
          rollouts.set(path, { cursor: start, context: [] });
        }
        const codex = rollout ??= createIncrementalRolloutReader(scanLedger, rollouts);
        decorate = codex.decorate;
        const claudeProjects = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
        const remoteProjects = join(cacheRoot(env, home), "remote");
        const remoteFiles = changes ? cachedRemoteFiles : list(remoteProjects, name => name.endsWith(".jsonl"));
        const claudeFiles = changes ? cachedClaudeFiles : [...remoteFiles.filter(path => !path.includes("/codex/")), ...list(claudeProjects, (name) => name.endsWith(".jsonl"))];
        const claudePaths = claudeFiles.filter((path) => changes
          ? changes.has(path) && readChanged(path) || pendingConflicts.has(path) : pendingConflicts.has(path) || readChanged(path) || !checkpoints.get(path)?.claudeUuidChain || needsClaudeContext(path)
            || checkpoints.get(path)?.claudeQueuedCommandsVersion !== CLAUDE_QUEUED_COMMANDS_VERSION
            || checkpoints.get(path)?.claudeHistoryDetailsVersion !== CLAUDE_HISTORY_DETAILS_VERSION
            || checkpoints.get(path)?.claudeMessageFlagsVersion !== CLAUDE_MESSAGE_FLAGS_VERSION);
        const codexHome = env.CODEX_HOME ?? join(home, ".codex");
        const codexFiles = changes ? cachedCodexFiles : [...remoteFiles.filter(path => path.includes("/codex/")), ...codex.reader.list(join(codexHome, "sessions")), ...codex.reader.list(join(codexHome, "archived_sessions"))];
        if (!changes) {
          const nextFiles = new Set([...claudeFiles, ...codexFiles]);
          if (nextFiles.size !== historyFiles.size || [...nextFiles].some(path => !historyFiles.has(path))) watchPathsDirty = true;
          historyFiles = nextFiles;
          cachedClaudeFiles = claudeFiles; cachedCodexFiles = codexFiles; cachedRemoteFiles = remoteFiles;
        }
        const codexPaths = new Set(codexFiles.filter(path => (!changes || changes.has(path) || pendingConflicts.has(path)) && (pendingConflicts.has(path) || readChanged(path) || !checkpoints.get(path)?.nativeStateEvidence
          || !changes && checkpoints.get(path)?.codexHistoryDetailsVersion !== CODEX_HISTORY_DETAILS_VERSION)));
        const codexLocations = codexFiles.filter((path) => codexPaths.has(path) || !changes && needsCodexLocation(path));
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
              observeClaudeHistories(scanLedger, claudeProjects, snapshot, trackBatch, claudePaths, checkpoints, locate,
                (path, operation) => observeFileBatch(path, "transcript-claude", () => trackBatch(operation), result => result.conflicts, result => result.pendingBytes === 0));
            }
            if (codexPaths.size) observeCodex(scanLedger,
              { codexHome, reader: codex.reader, paths: codexPaths, titleCursors: checkpoints, observeTitles: !changes,
                fileBatch: (path, operation) => observeFileBatch(path, "rollout-codex", () => trackBatch(operation),
                  results => results.filter(result => result.status === "conflict"), () => codex.isComplete(path)) });
          });
          if (!changes && !codexPaths.size) {
            const titles = buffered.batch(() => observeCodexTitles(scanLedger, codexHome, new Date().toISOString(), undefined, checkpoints));
            if (titles.some(result => result.status === "conflict")) throw new Error("Conflicting Codex title");
          }
          codex.commit();
          for (const path of codexPaths) {
            const state = rollouts.get(path);
            if (state) checkpoints.set(path, state.cursor);
          }
        } catch (error) { codex.discard(); throw error; }
        refreshSnapshot();
        if (codexLocations.length) {
          const localLocations = codexLocations.filter(path => !path.startsWith(remoteProjects + "/"));
          const located = buffered.batch(() => [...observeCodexLocations(scanLedger, localLocations, { facts: snapshot, locate }), ...codexLocations.filter(path => path.startsWith(remoteProjects + "/")).flatMap(path => {
            const remote = readRemoteMetadata(path);
            return observeCodexLocations(scanLedger, [path], { facts: snapshot, locate: remote ? () => ({ cwd: remote.cwd, repository_id: remote.projectId }) : locate });
          })]);
          if (located.some((result) => result.status === "conflict")) throw new Error("Conflicting Codex location");
          refreshSnapshot();
        }
        if (!changes) {
          const directThrough = Number(readLastSeq.get()!.seq ?? 0);
          function* readLaunchFacts(): Generator<Fact> {
            for (const row of readDirectFacts.iterate(directSeq, directThrough)) yield { ...row,
              payload: row.payload === null ? null : JSON.parse(String(row.payload)),
            } as Fact;
          }
          const localDirectFiles = codexFiles.filter(path => !path.startsWith(remoteProjects + "/"));
          const changedDirectFacts = directSeq !== directThrough
            && (readDirectFacts.get(directSeq, directThrough) || readDirectLocations.get(directSeq, directThrough));
          if (changedDirectFacts || claudePaths.length || codexPaths.size
            || localDirectFiles.length !== directFiles.length || localDirectFiles.some((path, index) => path !== directFiles[index])
            || directCodex.hasChangedPrompts()) {
            buffered.batch(() => directCodex(readLaunchFacts(), localDirectFiles, new Date().toISOString(), codexPaths));
            directFiles = localDirectFiles;
          }
          directSeq = directThrough;
          refreshSnapshot();
        }
        let aliases = { pending: 0, deferred: 0 };
        if (!changes) {
          aliases = kit.observe();
          refreshSnapshot();
          buffered.batch(() => observeRemoteStatus(scanLedger, remoteFiles, snapshot));

          refreshSnapshot();

        }
        const changedCheckpoints = [...checkpoints].filter(([path, cursor]) => previousCheckpoints.get(path) !== cursor);
        if (changedCheckpoints.some(([path]) => historyFiles.has(path))) watchPathsDirty = true;
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
