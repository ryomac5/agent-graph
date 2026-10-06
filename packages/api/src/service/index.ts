import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyIncremental, openLedger, rebuild } from "../../../core/src/ledger/index.ts";
import type { Fact, FactInput, Ledger } from "../../../core/src/ledger/index.ts";
import { createHookFacts, parseHookEvent } from "../hook/index.ts";
import type { HookEvent } from "../hook/index.ts";
import { observeClaudeHistories } from "./claude-reader.ts";
import { observeCodex } from "../observe/codex/index.ts";
import { createKitObserver } from "../observe/kit/index.ts";
import { hookOutboxPath, ledgerDbPath } from "../paths.ts";
import { createIncrementalRolloutReader } from "./codex-reader.ts";

export const PROJECTION_POLL_MS = 500;
export const OBSERVATION_POLL_MS = 1000;
export interface ObservationOptions {
  dbPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}
export interface IngestionReport {
  appended: number;
  unsupported: number;
  pending: number;
  deferred: number;
}

function ingestOutbox(ledger: Ledger, directory: string): void {
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
    for (const fact of createHookFacts(event)) {
      if (fact.kind === "conversation.created" && conversations.has(fact.subject)) continue;
      const result = ledger.append(fact);
      if (result.status === "conflict") throw new Error(`Conflicting hook event: ${event.event_id}`);
      if (fact.kind === "conversation.created") conversations.add(fact.subject);
    }
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
  const ledger = openLedger(dbPath);
  const projectionDb = new DatabaseSync(dbPath);
  projectionDb.exec("PRAGMA busy_timeout = 5000");
  let projectedSeq = 0;
  function catchUp() {
    projectionDb.exec("BEGIN IMMEDIATE");
    try {
      const current = projectionDb.prepare("SELECT generation, last_seq FROM projection_state WHERE id = 1").get()!;
      projectedSeq = Number(current.last_seq);
      const added = projectionDb.prepare("SELECT seq, kind FROM facts WHERE seq > ? ORDER BY seq").all(projectedSeq);
      // core は保存表のない実体だけの差分に未対応。位置も追記と同じロックで進める。
      if (added.every((fact) => String(fact.kind).startsWith("project.") || String(fact.kind).startsWith("observation."))) {
        if (added.length > 0) {
          projectedSeq = Number(added.at(-1)!.seq);
          projectionDb.prepare("UPDATE projection_state SET last_seq = ? WHERE id = 1").run(projectedSeq);
        }
        projectionDb.exec("COMMIT");
        return { generation: Number(current.generation), last_seq: projectedSeq };
      }
      projectionDb.exec("COMMIT");
    } catch (error) {
      projectionDb.exec("ROLLBACK");
      throw error;
    }
    const state = applyIncremental(projectionDb, projectedSeq);
    projectedSeq = state.last_seq;
    return state;
  }
  catchUp();
  // hook の受理直後も同じ差分反映を通す。
  let decorate = (input: FactInput): FactInput => input;
  let scanning = false;
  const projectedLedger: Ledger = { ...ledger, append(input) {
    const result = ledger.append(decorate(input));
    if (result.status === "appended" && !scanning) catchUp();
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
    rebuild() { const state = rebuild(projectionDb); projectedSeq = state.last_seq; return state; },
    ingestOnce(): IngestionReport {
      const start = catchUp().last_seq;
      snapshot = ledger.readSince(0, Number.MAX_SAFE_INTEGER);
      const snapshotSeq = snapshot.at(-1)?.seq ?? 0;
      scanning = true;
      try {
        const claudeProjects = join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
        if (existsSync(claudeProjects)) {
          const observations = observeClaudeHistories(scanLedger, claudeProjects, snapshot);
          if (observations.some((result) => result.conflicts.length > 0)) throw new Error("Conflicting Claude history");
        }
        try {
          const results = observeCodex(scanLedger, { codexHome: env.CODEX_HOME ?? join(home, ".codex"), reader: codex.reader });
          if (results.some((result) => result.status === "conflict")) throw new Error("Conflicting Codex history");
          codex.commit();
        } catch (error) { codex.discard(); throw error; }
        snapshot = snapshot.concat(ledger.readSince(snapshotSeq, Number.MAX_SAFE_INTEGER));
        ingestOutbox(scanLedger, hookOutboxPath(env, home));
        const latest = snapshot.at(-1)?.seq ?? 0;
        snapshot = snapshot.concat(ledger.readSince(latest, Number.MAX_SAFE_INTEGER));
        const aliases = kit.observe();
        const added = ledger.readSince(start, Number.MAX_SAFE_INTEGER);
        return { appended: added.length, unsupported: added.filter((fact) => fact.kind === "observation.unsupported").length,
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
