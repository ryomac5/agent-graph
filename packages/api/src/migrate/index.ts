import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { createRepositoryId } from "../../../core/src/ledger/index.ts";
import type { AppendResult, Confidence, Fact, FactInput, FactKind, FactPayloads, JsonValue, Ledger, Provider } from "../../../core/src/ledger/index.ts";

const FALLBACK_TS = "1970-01-01T00:00:00.000Z";
const FACT_BATCH_SIZE = 1000;
type Row = Record<string, SQLInputValue>;
type LegacyVersion = Pick<Fact, "fact_id" | "source_event_id" | "source_ts" | "confidence" | "subject"> & { digest: string };

export interface MigrationReport {
  databases: number;
  rows: Record<string, number>;
  facts: Partial<Record<FactKind, number>>;
  unsupported: number;
  errors: { path: string; reason: string }[];
  unknown: number;
  inferred: number;
}
export interface MigrationOptions {
  /** 各 DB の最新の複製を一つ保持する。省略時は旧 DB の隣に保存する。 */
  backupDirectory?: string;
}

function readLatestVersions(ledger: Ledger): Map<string, LegacyVersion> {
  const versions = new Map<string, LegacyVersion>();
  let seq = 0;
  for (;;) {
    const facts = ledger.readSince(seq, FACT_BATCH_SIZE);
    if (facts.length === 0) return versions;
    for (const fact of facts) {
      if (fact.source !== "legacy") continue;
      let identity: unknown;
      try {
        identity = JSON.parse(fact.source_event_id);
      } catch {
        // 他の旧キットの取り込みが使う識別子は対象外にする。
        continue;
      }
      if (!Array.isArray(identity) || (identity.length !== 5 && identity.length !== 6)
        || !identity.every((value) => typeof value === "string") || identity[3] !== fact.kind) continue;
      versions.set(JSON.stringify(identity.slice(0, 4)), { ...fact, digest: identity[4] });
    }
    seq = facts.at(-1)!.seq;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function readText(row: Row, key: string): string | undefined {
  return row[key] == null ? undefined : String(row[key]);
}
class UnsupportedRow extends Error {}

function readJson(row: Row, key: string): JsonValue {
  const value = readText(row, key);
  if (value === undefined) return null;
  try { return JSON.parse(value); } catch { throw new UnsupportedRow(`旧 ${key} の JSON を読めません`); }
}
function readProvider(row: Row): Provider {
  const client = String(row.client);
  if (client === "claude" || client === "codex") return client;
  throw new UnsupportedRow(`未対応の旧 client: ${client}`);
}
function resolveRepository(root: string): string {
  // 実在するリポジトリでは作業ツリーも git 共通ディレクトリで同一視する。
  try {
    const common = execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return createRepositoryId(realpathSync(common));
  } catch {
    // 消えた旧リポジトリは推定の git パスを確定 ID にせず、旧パスの名前空間に残す。
    return hash(JSON.stringify(["legacy-repository", root]));
  }
}

function appendFact(ledger: Ledger, input: FactInput): AppendResult {
  try {
    return ledger.append(input);
  } catch (error) {
    // 本文の処理が失敗した発言も、本文を空にして所属を残す。DB 障害は隠さない。
    if (!(error instanceof TypeError) || input.kind !== "message.created") throw error;
    return ledger.append({ ...input, payload: { ...input.payload, body: "", body_state: "unavailable" } });
  }
}

/** 件数は今回読み取った変換対象を数える。再送による duplicate も同じ件数を返す。 */
export async function migrateLegacyDatabases(
  paths: readonly string[], ledger: Ledger, options: MigrationOptions = {},
): Promise<MigrationReport> {
  const report: MigrationReport = { databases: 0, rows: {}, facts: {}, unsupported: 0, errors: [], unknown: 0, inferred: 0 };
  const versions = readLatestVersions(ledger);
  const seenPaths = new Set<string>();
  for (const inputPath of [...new Set(paths.map((value) => resolve(value)))].sort()) {
    let db: DatabaseSync | undefined;
    let readingInput = true;
    try {
      const path = realpathSync(inputPath);
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      db = new DatabaseSync(path, { readOnly: true });
      db.prepare("SELECT name FROM sqlite_master").all();
      readingInput = false;
      // backup は WAL 内の確定済みのページも複製する。失敗したら追記を始めない。
      const directory = options.backupDirectory ?? `${path}.migration-backups`;
      mkdirSync(directory, { recursive: true });
      const temporary = mkdtempSync(join(directory, `${basename(path)}-`));
      try {
        const snapshotPath = join(temporary, "agent-graph.db");
        await backup(db, snapshotPath);
        // WAL モードを複製側だけで解消し、一つのファイルで復元できるようにする。
        const saved = new DatabaseSync(snapshotPath);
        try {
          saved.exec("PRAGMA journal_mode = DELETE");
        } finally {
          saved.close();
        }
        const savedPath = join(temporary, "saved.db");
        copyFileSync(snapshotPath, savedPath);
        renameSync(savedPath, join(directory, `${basename(path)}-${hash(path)}.db`));
        const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
        try {
          // 各取り込みは専用の複製を読む。保存した最新のバックアップとは分ける。
          migrateSnapshot(snapshot, ledger, report, versions, path);
        } finally {
          snapshot.close();
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      report.databases += 1;
    } catch (error) {
      // 読めない入力だけを飛ばす。バックアップと台帳の障害は呼び出し元へ返す。
      if (!readingInput || !(error instanceof Error && "code" in error
        && (["SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "ENOENT", "EACCES", "EPERM"].includes(String(error.code))
          || (error.code === "ERR_SQLITE_ERROR" && "errcode" in error && [11, 14, 26].includes(Number(error.errcode)))))) throw error;
      report.errors.push({ path: inputPath, reason: error.message });
    } finally {
      db?.close();
    }
  }
  return report;
}

function migrateSnapshot(db: DatabaseSync, ledger: Ledger, report: MigrationReport, versions: Map<string, LegacyVersion>, path: string): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
  function readRows(table: string): Row[] {
    if (!tables.has(table)) return [];
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
    report.rows[table] = (report.rows[table] ?? 0) + rows.length;
    return rows;
  }
  const repos = readRows("repos");
  const sessions = readRows("sessions");
  const sessionById = new Map(sessions.map((row) => [String(row.id), row]));
  const projects = new Map(repos.map((row) => [String(row.key), resolveRepository(String(row.root_path))]));
  // DB の置き場が変わっても、repo key と旧行の主キーから同じ識別子を作る。
  const namespace = JSON.stringify(repos.map((row) => String(row.key)).sort());
  function identify(entity: string, id: string): string {
    return `legacy-${hash(JSON.stringify([namespace, entity, id]))}`;
  }
  function emit<K extends FactKind>(
    table: string, key: string, kind: K, subject: FactInput["subject"], payload: FactPayloads[K],
    ts = FALLBACK_TS, confidence: Confidence = "confirmed",
  ): string {
    const identity = [namespace, table, key, kind];
    const versionKey = JSON.stringify(identity);
    const previous = versions.get(versionKey);
    const digest = hash(JSON.stringify(payload));
    const unchanged = previous?.digest === digest && previous.source_ts === ts
      && previous.confidence === confidence && previous.subject === subject;
    // 直前の版を置き換える。以前の内容に戻っても新しい版として追記する。
    const source_event_id = unchanged ? previous.source_event_id
      : JSON.stringify([...identity, digest, ...(previous ? [previous.fact_id] : [])]);
    const supersedes = unchanged ? undefined : previous?.fact_id;
    const result = appendFact(ledger, { source: "legacy", source_event_id, kind, subject, payload,
      source_ts: ts, confidence, ...(supersedes ? { supersedes } : {}) } as FactInput);
    if (result.status === "conflict") throw new Error(`移行の事実が衝突しました: ${table}`);
    versions.set(versionKey, { fact_id: result.fact_id, source_event_id, digest, source_ts: ts, confidence, subject });
    report.facts[kind] = (report.facts[kind] ?? 0) + 1;
    if (confidence === "unknown") report.unknown += 1;
    if (confidence === "inferred") report.inferred += 1;
    return result.fact_id;
  }
  function unsupported(table: string, key: string, reason: string): void {
    emit(table, key, "observation.unsupported", `observation:${identify("unsupported", JSON.stringify([table, key]))}`, {
      source_kind: "legacy", file_path: path, format_name: table, format_version: "legacy", reason,
    });
    report.unsupported += 1;
  }
  function migrateRows(table: string, rows: Row[], convert: (row: Row) => void): void {
    for (const row of rows) {
      try { convert(row); } catch (error) {
        if (!(error instanceof UnsupportedRow)) throw error;
        unsupported(table, JSON.stringify([row.id ?? row.delegation_id ?? row.key, row.seq ?? null]), error.message);
      }
    }
  }
  const migratedSessions = new Set<string>();
  const migratedDelegations = new Set<string>();
  function conversationId(id: string): string { return identify("conversation", id); }
  function runId(id: string): string { return identify("run", id); }
  for (const row of repos) {
    const repository_id = projects.get(String(row.key))!;
    emit("repos", String(row.key), "project.created", `project:${repository_id}`, {
      repository_id, root_path: String(row.root_path), display_name: String(row.name),
      name_prefix: String(row.name), state: "registered",
    });
  }
  migrateRows("sessions", sessions, (row) => {
    const id = String(row.id);
    const ts = String(row.started_at);
    const taskId = identify("task", id);
    const planner = row.client === "planner";
    const provider = planner ? undefined : readProvider(row);
    if (row.status != null && !["running", "waiting", "ended"].includes(String(row.status))) {
      throw new UnsupportedRow(`未対応の旧 session status: ${row.status}`);
    }
    if (!projects.has(String(row.repo_key))) throw new UnsupportedRow("旧 session の repo がありません");
    emit("sessions", id, "task.created", `task:${taskId}`, {
      purpose: readText(row, "goal") ?? "", project: projects.get(String(row.repo_key))!, state: "open",
      ...(planner ? { origin: "planner" } : {}),
    }, ts);
    emit("sessions", id, "alias.created", `alias:${identify("alias", id + String(row.name))}`, {
      entity_id: taskId, kind: "legacy", name: String(row.name),
    }, ts);
    migratedSessions.add(id);
    if (planner) return;
    emit("sessions", id, "conversation.created", `conversation:${conversationId(id)}`, {
      provider: provider!, native_id: id, origin: "observed", type: "interactive", history_format: "legacy", task_id: taskId,
    }, ts);

    emit("sessions", id, "run.created", `run:${runId(id)}`, {
      conversation_id: conversationId(id), generation: 0, state: "starting", started_ts: ts,
      repository_id: projects.get(String(row.repo_key))!,
      ...(row.pid == null ? {} : { pid: Number(row.pid) }),
      ...(row.pid_started_at == null ? {} : { start_fingerprint: String(row.pid_started_at) }),
    }, ts);
    const ended = row.status === "ended";
    const explicit = ended && row.ended_reason === "explicit";
    const unknown = ended && !explicit;
    emit("sessions", id, "run.state_changed", `run:${runId(id)}`, {
      state: unknown ? "unknown" : explicit ? "ended" : row.status === "waiting" ? "waiting_input" : "running",
      ...(explicit ? { ended_ts: readText(row, "ended_at") ?? ts, end_evidence: { kind: "explicit", legacy_reason: "explicit" } } : {}),
      ...(unknown ? { reason: `legacy ended inference: ${readText(row, "ended_reason") ?? "missing evidence"}`,
        last_evidence: { status: "ended", ended_reason: readText(row, "ended_reason") ?? null, ended_at: readText(row, "ended_at") ?? null } } : {}),
    }, readText(row, "ended_at") ?? readText(row, "last_seen_at") ?? ts, unknown ? "unknown" : "confirmed");
    for (const [column, type, confidence] of [
      ["continued_in", "continued", "confirmed"], ["source_thread_id", "copied", "inferred"],
    ] as const) {
      const target = readText(row, column);
      if (!target) continue;
      if (sessionById.has(target) && !["claude", "codex"].includes(String(sessionById.get(target)!.client))) {
        unsupported("sessions", `${id}:${column}`, "旧関係の対象は会話ではありません");
        continue;
      }
      if (!sessionById.has(target)) {
        emit("sessions", `${id}:${column}:target`, "conversation.created", `conversation:${conversationId(target)}`, {
          provider: readProvider(row), native_id: target, origin: "observed", type: "interactive", history_format: "legacy",
        }, ts, confidence);
      }
      emit("sessions", `${id}:${column}`, "relation.created", `relation:${identify("relation", JSON.stringify([id, column, target]))}`, {
        type, from_id: conversationId(id), to_id: conversationId(target), active: true,
        evidence: { table: "sessions", column, session_id: id, value: target }, confidence,
      }, ts, confidence);
    }
  });
  migrateRows("turns", readRows("turns"), (row) => {
    const session = sessionById.get(String(row.session_id));
    if (!session || !migratedSessions.has(String(row.session_id))) throw new UnsupportedRow("旧 turn の session がありません、または未対応です");
    readProvider(session);
    for (const [column, role] of [["prompt", "user"], ["reply", "assistant"]] as const) {
      const body = readText(row, column) ?? (column === "reply" ? readText(row, "summary") : undefined);
      if (body === undefined) continue;
      const key = JSON.stringify([String(row.id), column]);
      const messageId = identify("message", key);
      emit("turns", key, "message.created", `message:${messageId}`, {
        provider: readProvider(session), native_id: `${row.id}:${column}`, version: 1, role, body, body_state: "stored",
      }, String(row.at));
      emit("turns", key, "message_membership.created", `message_membership:${identify("membership", key)}`, {
        message_id: messageId, conversation_id: conversationId(String(row.session_id)), active: row.hidden !== 1,
      }, String(row.at));
    }
  });
  const requestRows = readRows("delegation_requests");
  const requests = new Map<string, JsonValue>();
  const delegations = readRows("delegations");
  const delegationById = new Map(delegations.map((row) => [String(row.id), row]));
  migrateRows("delegation_requests", requestRows, (row) => {
    const id = String(row.delegation_id);
    if (!delegationById.has(id)) throw new UnsupportedRow("旧 request の delegation がありません");
    requests.set(id, readJson(row, "request"));
  });
  function delegationTs(row: Row): string {
    return readText(sessionById.get(String(row.session_id)) ?? {}, "started_at") ?? FALLBACK_TS;
  }
  migrateRows("delegations", delegations, (row) => {
    const id = String(row.id);
    const request = requests.get(id);
    const parent = row.session_id == null ? undefined : String(row.session_id);
    const states: Record<string, FactPayloads["delegation.state_changed"]["state"]> = {
      pending: "received", running: "running", done: "done", failed: "failed", timeout: "failed", denied: "denied", lost: "interrupted",
    };
    if (row.kind != null && !["delegation", "subagent"].includes(String(row.kind))) {
      throw new UnsupportedRow(`未対応の旧 delegation kind: ${row.kind}`);
    }
    if (!Object.hasOwn(states, String(row.status))) throw new UnsupportedRow(`未対応の旧 delegation status: ${row.status}`);
    const planner = parent !== undefined && sessionById.get(parent)?.client === "planner" && migratedSessions.has(parent);
    const knownParent = parent !== undefined && migratedSessions.has(parent);
    const subject = `delegation:${identify("delegation", id)}` as const;
    emit("delegations", id, "delegation.created", subject, {
      request_id: id, role: String(row.role), title: String(row.title), attempt: 0, state: "received",
      ...(knownParent && !planner ? { parent_run_id: runId(parent!) } : {}),
      ...(row.task == null ? {} : { task: String(row.task) }),
      ...(row.scope == null ? {} : { scope: readJson(row, "scope") as string[] }),
      ...(row.worktree == null ? {} : { cwd: String(row.worktree) }),
      constraints: { legacy_parent_id: readText(row, "parent_id") ?? null, legacy_kind: String(row.kind ?? "delegation"),
        request: request ?? null, outputs: readJson(row, "outputs") },
    }, delegationTs(row), knownParent ? "confirmed" : "unknown");
    migratedDelegations.add(id);
    if (planner) {
      emit("delegations", id, "relation.created", `relation:${identify("planner-delegation", id)}`, {
        type: "delegated", from_id: identify("task", parent!), to_id: id, active: true,
        confidence: "confirmed", evidence: { table: "delegations", column: "session_id", session_id: parent!, client: "planner" },
      }, delegationTs(row));
    }
    emit("delegations", id, "delegation.state_changed", subject, {
      attempt: Number(row.round_trips ?? 0), state: states[String(row.status)],
      ...(row.output == null ? {} : { result: String(row.output) }),
    }, delegationTs(row));
  });
  for (const table of ["delegation_rounds", "assignments", "acceptances", "reviews"]) {
    migrateRows(table, readRows(table), (row) => {
      const id = String(row.delegation_id);
      const delegation = delegationById.get(id);
      if (!delegation || !migratedDelegations.has(id)) throw new UnsupportedRow("旧試行の delegation がありません、または未対応です");
      if (table === "delegation_rounds" && !["request", "reinstruct", "report"].includes(String(row.kind))) {
        throw new UnsupportedRow(`未対応の旧 round kind: ${row.kind}`);
      }
      // request/report の対を同じ試行にする。reinstruct から次の試行になる。
      const attempt = table === "delegation_rounds" ? Math.floor((Number(row.seq) - 1) / 2) : Number(delegation.round_trips ?? 0);
      const payload: FactPayloads["delegation.attempt_created"] = { attempt };
      if (table === "assignments") payload.assignment = row as Record<string, string | number | null>;
      if (table === "acceptances") payload.verification = {
        passed: row.passed === 1, results: readJson(row, "results"), scope_violations: readJson(row, "scope_violations"),
      };
      if (table === "reviews") payload.review = {
        reviewer_delegation_id: String(row.reviewer_delegation_id), verdict: String(row.verdict), comment: String(row.comment),
      };
      // 往復の本文と種類は試行の証拠として残す。
      if (table === "delegation_rounds") payload.assignment = { legacy_round: { kind: String(row.kind), text: String(row.text), at: String(row.at) } };
      emit(table, JSON.stringify([id, row.seq ?? null]), "delegation.attempt_created",
        `delegation:${identify("delegation", id)}`, payload, readText(row, "at") ?? delegationTs(delegation));
    });
  }
}
