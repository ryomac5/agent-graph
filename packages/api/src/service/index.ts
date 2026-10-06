import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
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
import { createIncrementalRolloutReader } from "./codex-reader.ts";
import { openBatchLedger } from "./batch-ledger.ts";

const PROJECTION_CACHE_KIB = 128 * 1024;
export const PROJECTION_POLL_MS = 500;
export const OBSERVATION_POLL_MS = 1000;
export interface ObservationOptions {
  dbPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  live?: boolean;
}
export interface IngestionReport {
  appended: number;
  unsupported: number;
  pending: number;
  deferred: number;
}

function ingestOutbox(ledger: Ledger, directory: string, batch: <T>(operation: () => T) => T): void {
  if (!existsSync(directory)) return;
  const names = readdirSync(directory).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort();
  if (names.length === 0) return;
  const conversations = new Set(ledger.readSince(0, Number.MAX_SAFE_INTEGER)
    .filter((fact) => fact.kind === "conversation.created").map((fact) => fact.subject));
  for (const name of names) {
    const path = join(directory, name);
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
  const buffered = openBatchLedger(dbPath);
  const ledger = buffered.ledger;
  const projectionDb = new DatabaseSync(dbPath);
  // まとめた投影の書き込みで、小さなキャッシュの退避を繰り返さない。
  projectionDb.exec(`PRAGMA busy_timeout = 5000; PRAGMA cache_size = -${PROJECTION_CACHE_KIB}`);
  const readNewMetadata = projectionDb.prepare(`SELECT * FROM facts WHERE seq > ?
    AND (kind LIKE 'conversation.%' OR kind LIKE 'project.%') ORDER BY seq`);
  const readLastSeq = projectionDb.prepare("SELECT max(seq) AS seq FROM facts");
  const countAdded = projectionDb.prepare(`SELECT count(*) AS appended,
    coalesce(sum(kind = 'observation.unsupported'), 0) AS unsupported FROM facts WHERE seq > ?`);
  function readMetadata(seq: number): Fact[] {
    return readNewMetadata.all(seq).map((row) => ({ ...row,
      payload: row.payload === null ? null : JSON.parse(String(row.payload)),
    } as Fact));
  }
  let projectedSeq = 0;
  let lastProjectionTime = performance.now();
  function catchUp() {
    const state = applyIncremental(projectionDb, projectedSeq);
    projectedSeq = state.last_seq;
    lastProjectionTime = performance.now();
    return state;
  }
  catchUp();
  // 追記は受理前に確定し、投影は走査の終了か常駐の周期でまとめる。
  let decorate = (input: FactInput): FactInput => input;
  let scanning = false;
  const projectedLedger: Ledger = { ...ledger, append(input) {
    const result = ledger.append(decorate(input));
    if (result.status === "appended" && scanning && options.live
      && performance.now() - lastProjectionTime >= PROJECTION_POLL_MS) {
      buffered.flush(catchUp);
    }
    return result;
  } };
  let snapshot: Fact[] = [];
  const scanLedger: Ledger = { ...projectedLedger,
    append: (input) => projectedLedger.append(input),
    readSince: (seq, limit) => seq === 0 && limit === Number.MAX_SAFE_INTEGER
      ? snapshot : ledger.readSince(seq, limit),
  };
  const kit = createKitObserver(scanLedger);
  const codex = createIncrementalRolloutReader(projectedLedger);
  decorate = codex.decorate;
  return {
    ledger: projectedLedger,
    dbPath,
    outbox: hookOutboxPath(env, home),
    catchUp,
    batch: buffered.batch,
    rebuild() { const state = rebuild(projectionDb); projectedSeq = state.last_seq; return state; },
    ingestOnce(): IngestionReport {
      snapshot = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
      const snapshotSeq = snapshot.at(-1)?.seq ?? 0;
      const start = snapshotSeq;
      scanning = true;
      try {
        const claudeProjects = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
        if (existsSync(claudeProjects)) {
          const observations = observeClaudeHistories(scanLedger, claudeProjects, snapshot, buffered.batch);
          if (observations.some((result) => result.conflicts.length > 0)) throw new Error("Conflicting Claude history");
        }
        try {
          const results = observeCodex(scanLedger, { codexHome: env.CODEX_HOME ?? join(home, ".codex"), reader: codex.reader,
            batch: buffered.batch });
          if (results.some((result) => result.status === "conflict")) throw new Error("Conflicting Codex history");
          codex.commit();
        } catch (error) { codex.discard(); throw error; }
        // 後続の hook と別名には会話とプロジェクトだけが必要になる。
        snapshot = snapshot.concat(readMetadata(snapshotSeq));
        const latest = Number(readLastSeq.get()!.seq ?? 0);
        ingestOutbox(scanLedger, hookOutboxPath(env, home), buffered.batch);
        snapshot = snapshot.concat(readMetadata(latest));
        const aliases = kit.observe();
        const added = countAdded.get(start)!;
        return { appended: Number(added.appended), unsupported: Number(added.unsupported),
          pending: aliases.pending, deferred: aliases.deferred };
      } finally {
        scanning = false;
        snapshot = [];
        catchUp();
      }
    },
    close() { projectionDb.close(); ledger.close(); },
  };
}
