import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { resolveProjectLocation, toProjectPayload } from "../../../core/src/ledger/repository.ts";
import type { GitRunner, ProjectLocation } from "../../../core/src/ledger/repository.ts";
import type { AppendResult, Confidence, Fact, FactInput, FactKind, FactPayloads, JsonValue, Ledger, Provider } from "../../../core/src/ledger/index.ts";
import type { BatchLedger } from "../service/batch-ledger.ts";

const FALLBACK_TS = "1970-01-01T00:00:00.000Z";
const FACT_BATCH_SIZE = 1000;
type Row = Record<string, SQLInputValue>;
type LegacyVersion = Pick<Fact, "fact_id" | "source_event_id" | "source_ts" | "confidence" | "subject"> & { digest: string };

function indexRows(rows: Iterable<Row>, key: (row: Row) => string): Map<string, Row[]> {
  const index = new Map<string, Row[]>();
  for (const row of rows) {
    const id = key(row);
    const matches = index.get(id) ?? [];
    matches.push(row);
    index.set(id, matches);
  }
  return index;
}

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
  /** 各 DB の追記が確定した後に、まとめて投影を反映する。 */
  afterDatabase?: () => void;
  batch?: <T>(operation: () => T) => T;
  /** 一時の場所の判定に使う置き場。省略時は切り替えの導入と同じ既定を使う。 */
  temporaryRoots?: readonly string[];
  git?: GitRunner;
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
      versions.set(JSON.stringify(identity.slice(0, 4)), { fact_id: fact.fact_id, source_event_id: fact.source_event_id,
        source_ts: fact.source_ts, confidence: fact.confidence, subject: fact.subject, digest: identity[4] });
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

const NAME_LENGTH = 160;
function normalizeLegacyRequest(body: string | undefined): string {
  const text = body?.trim() ?? "";
  return text.replace(/^無人実行です。[ \t]*質問せずに[^\n]*(?:\n|$)/u, "").trim();
}
function extractTaskTitle(body: string | undefined): string {
  if (!body?.trim()) return "";
  const heading = body.match(/^\s*#{1,6}\s+(?:タスク|Task)\s+[^:：\n]+[:：]\s*(.+)$/mi)
    ?? body.match(/^\s*#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim().slice(0, NAME_LENGTH);
  return body.split(/\n|(?<=[。.!?？！])/u).map(line => line.trim()).find(line => line
    && !/^(無人実行です|質問せずに|Review a delegated task|You are (?:an? |the )|<)/i.test(line))?.slice(0, NAME_LENGTH) ?? "";
}

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

function appendFact(ledger: Ledger, input: FactInput): AppendResult {
  try {
    return ledger.append(input);
  } catch (error) {
    // 本文の処理が失敗した発言も、本文を空にして所属を残す。DB 障害は隠さない。
    if (!(error instanceof TypeError) || input.kind !== "message.created") throw error;
    return ledger.append({ ...input, payload: { ...input.payload, body: "", body_state: "unavailable" } });
  }
}

function isUnreadableDatabase(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (["SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "ENOENT", "EACCES", "EPERM"].includes(String(error.code))
      || (error.code === "ERR_SQLITE_ERROR" && "errcode" in error && [11, 14, 26].includes(Number(error.errcode))));
}

// 親と子が別の旧 DB に保存されるため、委譲の対応表は変換対象全体で持つ。
function readDelegationCatalog(paths: readonly string[]): Row[] {
  const catalog = new Map<string, Row>();
  const sessions = new Map<string, Row>();
  for (const path of paths) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
      if (!tables.has("repos") || !tables.has("delegations")) continue;
      const namespace = JSON.stringify(db.prepare("SELECT key FROM repos ORDER BY key").all().map(row => String(row.key)));
      if (tables.has("sessions")) {
        const hidden = tables.has("turns") && db.prepare("PRAGMA table_info(turns)").all().some(row => row.name === "hidden");
        const prompts = new Map<string, SQLInputValue>();
        if (tables.has("turns")) for (const row of db.prepare(`SELECT session_id, prompt FROM turns
          WHERE trim(coalesce(prompt, '')) <> '' ${hidden ? "AND coalesce(hidden, 0) <> 1" : ""}
          ORDER BY at, id`).iterate()) {
          const id = String(row.session_id);
          if (!prompts.has(id)) prompts.set(id, row.prompt);
        }
        for (const session of db.prepare("SELECT id FROM sessions").iterate()) {
          sessions.set(JSON.stringify([namespace, String(session.id)]), { ...session, prompt: prompts.get(String(session.id)) ?? null, namespace });
        }
      }
      const tasks = indexRows(tables.has("tasks") ? db.prepare("SELECT id, title FROM tasks").iterate() : [], row => String(row.id));
      const requests = indexRows(tables.has("delegation_requests") ? db.prepare(`SELECT delegation_id,
        json_extract(request, '$.task') AS task FROM delegation_requests WHERE json_valid(request)`).iterate() : [], row => String(row.delegation_id));
      for (const row of db.prepare("SELECT * FROM delegations ORDER BY rowid").iterate()) {
        const identity = JSON.stringify([namespace, String(row.id)]);
        const matchingTasks = row.task_id == null ? [] : tasks.get(String(row.task_id)) ?? [];
        catalog.set(identity, { id: row.id, session_id: row.session_id, parent_id: row.parent_id,
          role: row.role, title: row.title || (matchingTasks.length === 1 ? matchingTasks[0].title : null), status: row.status, child_session_id: row.child_session_id ?? null,
          task: row.task ?? requests.get(String(row.id))?.[0]?.task ?? null,
          ended_at: row.ended_at ?? null, namespace, file_path: resolve(path) } as Row);
      }
    } catch (error) {
      if (!isUnreadableDatabase(error)) throw error;
      // 読めない入力の報告は、バックアップを取る本経路で行う。
    } finally { db?.close(); }
  }
  const delegations = [...catalog.values()];
  const sessionsById = indexRows(sessions.values(), row => String(row.id));
  const sessionsByRequest = indexRows(sessions.values(), row => normalizeLegacyRequest(readText(row, "prompt")));
  const delegationsByRequest = indexRows(delegations, row => normalizeLegacyRequest(readText(row, "task")));
  // 同じ依頼を持つ子が複数の DB にあれば、終了の記録をどの子にも断定しない。
  for (const row of delegations) {
    const request = normalizeLegacyRequest(readText(row, "task"));
    const explicit = [...new Set([...(sessionsById.get(readText(row, "child_session_id") ?? "") ?? []),
      ...(sessionsById.get(String(row.id)) ?? [])])].filter(session => String(session.id) !== String(row.session_id));
    const uniqueRequest = request && delegationsByRequest.get(request)?.length === 1;
    const matches = explicit.length ? explicit : uniqueRequest
      ? (sessionsByRequest.get(request) ?? []).filter(session => String(session.id) !== String(row.session_id)) : [];
    if (matches.length === 1) {
      row.target_namespace = matches[0].namespace;
      row.target_session_id = matches[0].id;
    }
  }
  return delegations;
}

/** 件数は今回読み取った変換対象を数える。再送による duplicate も同じ件数を返す。 */
export async function migrateLegacyDatabases(
  paths: readonly string[], ledger: Ledger, options: MigrationOptions = {},
): Promise<MigrationReport> {
  const report: MigrationReport = { databases: 0, rows: {}, facts: {}, unsupported: 0, errors: [], unknown: 0, inferred: 0 };
  const versions = readLatestVersions(ledger);
  const catalog = readDelegationCatalog([...new Set(paths.map(value => resolve(value)))]);
  const seenPaths = new Set<string>();
  const locations = new Map<string, ProjectLocation>();
  // 同じパスは 1 回だけ git に問い合わせる。判定は導入の登録と同じ関数で行う。
  const locate = (root: string) => {
    if (!locations.has(root)) locations.set(root, resolveProjectLocation(root, { temporaryRoots: options.temporaryRoots, git: options.git }));
    return locations.get(root)!;
  };
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
          const batch = options.batch ?? (ledger as Partial<BatchLedger>).batch ?? ((operation) => operation());
          batch(() => migrateSnapshot(snapshot, ledger, report, versions, path, locate, catalog));
          options.afterDatabase?.();
        } finally {
          snapshot.close();
        }
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      report.databases += 1;
    } catch (error) {
      // 読めない入力だけを飛ばす。バックアップと台帳の障害は呼び出し元へ返す。
      if (!readingInput || !isUnreadableDatabase(error)) throw error;
      report.errors.push({ path: inputPath, reason: (error as Error).message });
    } finally {
      db?.close();
    }
  }
  return report;
}

function migrateSnapshot(
  db: DatabaseSync, ledger: Ledger, report: MigrationReport, versions: Map<string, LegacyVersion>, path: string,
  locate: (root: string) => ProjectLocation,
  catalog: Row[],
): void {
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
  const turns = readRows("turns");
  const delegations = readRows("delegations");
  const oldTasks = tables.has("tasks") ? db.prepare("SELECT * FROM tasks ORDER BY graph_id, id").all() as Row[] : [];
  const tasksById = indexRows(oldTasks, row => String(row.id));
  const catalogById = new Map(catalog.map(row => [JSON.stringify([row.namespace, String(row.id)]), row]));
  const namespace = JSON.stringify(repos.map((row) => String(row.key)).sort());
  const firstRequests = new Map<string, string>();
  for (const row of [...turns].sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)))) {
    if (row.hidden === 1 || !readText(row, "prompt")?.trim()) continue;
    if (!firstRequests.has(String(row.session_id))) firstRequests.set(String(row.session_id), String(row.prompt));
  }
  // 親 session_id は実行先に使わず、明示 ID または一意の依頼本文で子を結ぶ。
  const delegationBySession = new Map<string, Row>();
  for (const row of catalog) {
    if (row.target_namespace !== namespace || !row.target_session_id) continue;
    const id = String(row.target_session_id);
    if (!delegationBySession.has(id)) delegationBySession.set(id, row);
  }
  function titleDelegation(row: Row): string {
    const title = extractTaskTitle(readText(row, "title")) || extractTaskTitle(readText(row, "task"));
    if (row.role !== "review") return title;
    const parent = catalogById.get(JSON.stringify([row.namespace, readText(row, "parent_id")]));
    const original = parent ? extractTaskTitle(readText(parent, "title")) || extractTaskTitle(readText(parent, "task"))
      : title.replace(/^Review(?: of|:)\s*/i, "");
    return original ? `Review of ${original}` : "";
  }
  function nameSession(row: Row): string {
    const delegation = delegationBySession.get(String(row.id));
    const oldTask = tasksById.get(String(row.id)) ?? [];
    const request = firstRequests.get(String(row.id));
    const title = extractTaskTitle(request);
    return (delegation ? titleDelegation(delegation) : "")
      || (oldTask.length === 1 ? extractTaskTitle(readText(oldTask[0], "title")) : "")
      || (title && /^Review a delegated task\./i.test(request?.trim() ?? "") ? `Review of ${title}` : title)
      || extractTaskTitle(readText(row, "goal"));
  }
  const locations = new Map(repos.map((row) => [String(row.key), locate(String(row.root_path))]));
  const projects = new Map([...locations].map(([key, location]) => [key, location.repository_id]));
  // DB の置き場が変わっても、repo key と旧行の主キーから同じ識別子を作る。
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
    // 作業ツリーの行も本体のプロジェクトとして写す。表示名は本体のディレクトリ名で、行の名前で上書きしない。
    // 一時の場所と消えたリポジトリは登録せず、その会話は観測した会話として残す。
    const payload = toProjectPayload(locations.get(String(row.key))!);
    emit("repos", String(row.key), "project.created", `project:${payload.repository_id}`, payload);
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
      name: nameSession(row), purpose: readText(row, "goal") ?? "", project: projects.get(String(row.repo_key))!, state: "open",
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
    const delegation = delegationBySession.get(id);
    const completed = delegation && (delegation.status === "done" || delegation.status === "failed");
    const ended = row.status === "ended";
    const explicit = ended && row.ended_reason === "explicit";
    const unknown = ended && !explicit;
    emit("sessions", id, "run.state_changed", `run:${runId(id)}`, {
      state: completed ? delegation.status === "done" ? "ended" : "failed"
        : unknown ? "unknown" : explicit ? "ended" : row.status === "waiting" ? "waiting_input" : "running",
      ...(completed ? { ended_ts: readText(delegation, "ended_at") ?? readText(row, "ended_at") ?? ts,
        end_evidence: { kind: "legacy_delegation", table: "delegations", id: String(delegation.id), status: String(delegation.status), file_path: String(delegation.file_path) },
        ...(delegation.status === "failed" ? { cause: "legacy delegation failed" } : {}) } : {}),
      ...(explicit && !completed ? { ended_ts: readText(row, "ended_at") ?? ts, end_evidence: { kind: "explicit", legacy_reason: "explicit" } } : {}),
      ...(unknown && !completed ? { reason: `legacy ended inference: ${readText(row, "ended_reason") ?? "missing evidence"}`,
        last_evidence: { status: "ended", ended_reason: readText(row, "ended_reason") ?? null, ended_at: readText(row, "ended_at") ?? null } } : {}),
    }, readText(row, "ended_at") ?? readText(row, "last_seen_at") ?? ts, unknown && !completed ? "unknown" : "confirmed");
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
  migrateRows("turns", turns, (row) => {
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
