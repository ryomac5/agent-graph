import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BUSY_TIMEOUT_MS, openLedger } from "../../../core/src/ledger/index.ts";
import type { AppendResult, Fact, FactInput, Ledger } from "../../../core/src/ledger/index.ts";

const STAGING_FACT_LIMIT = 4096;
const BATCH_CACHE_KIB = 64 * 1024;
export interface BatchLedger extends Ledger {
  batch<T>(operation: () => T): T;
}

/** core が保存した事実と依存をそのまま移し、耐久の追記を一つの取引にまとめる。 */
export function openBatchLedger(path: string) {
  const base = openLedger(path);
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;
    PRAGMA wal_autocheckpoint = 0; PRAGMA temp_store = MEMORY`);
  db.exec(`PRAGMA cache_size = -${BATCH_CACHE_KIB}`);
  const stagingPath = `file:api-staging-${randomUUID()}?mode=memory&cache=shared`;
  const staging = openLedger(stagingPath);
  const stagingDb = new DatabaseSync(stagingPath);
  // 準備側では投影しないため、耐久台帳に必要な検索索引の二重更新を省く。
  stagingDb.exec("DROP INDEX fact_projection_dependency_lookup; DROP INDEX facts_subject_seq");
  // 準備側の依存は順次に貯め、索引と重複排除は耐久側で一度だけ行う。
  stagingDb.exec(`DROP TABLE fact_projection_dependencies;
    CREATE TABLE fact_projection_dependencies (
      projection TEXT NOT NULL, subject TEXT NOT NULL, direction TEXT NOT NULL,
      key TEXT NOT NULL, seq INTEGER NOT NULL
    )`);
  // 準備台帳は追記と全消去だけに使う。検索の削除処理を各事実で繰り返さない。
  for (const row of stagingDb.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()) {
    stagingDb.exec(`DROP TRIGGER "${String(row.name).replaceAll('"', '""')}"`);
  }
  const columns = db.prepare("PRAGMA main.table_info(facts)").all()
    .map((row) => String(row.name)).filter((name) => name !== "seq");
  const quotedColumns = columns.map((name) => `"${name.replaceAll('"', '""')}"`);
  const existing = db.prepare("SELECT seq, fact_id, payload_hash FROM main.facts WHERE source = ? AND source_event_id = ?");
  const preparedHash = stagingDb.prepare("SELECT payload_hash FROM facts WHERE seq = ?");
  const read = db.prepare("SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT ?");
  db.exec(`CREATE TEMP TABLE pending_facts (staging_seq INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
    PRAGMA read_uncommitted = ON`);
  const reserve = db.prepare("INSERT INTO pending_facts VALUES (?, ?)");
  const pending = new Map<string, { seq: number; payloadHash: string }>();
  let stagedCount = 0;
  let nextSeq = 0;
  let batching = false;
  let buildIndexes = false;
  let copyFacts: ReturnType<DatabaseSync["prepare"]>;
  let copyDependencies: ReturnType<DatabaseSync["prepare"]>;
  let copyFact: ReturnType<DatabaseSync["prepare"]>;
  let copyDependency: ReturnType<DatabaseSync["prepare"]>;
  let readBatch: ReturnType<DatabaseSync["prepare"]>;
  const attachStaging = db.prepare("ATTACH DATABASE ? AS staging");
  const readSequence = db.prepare("SELECT seq FROM main.sqlite_sequence WHERE name = 'facts'");

  function begin(): void {
    // BEGIN IMMEDIATE が準備側もロックしないよう、開始後に共有メモリを接続する。
    db.exec("BEGIN IMMEDIATE");
    attachStaging.run(stagingPath);
    nextSeq = Number(readSequence.get()?.seq ?? 0);
    // 空の台帳への初回投入だけ、二次索引を取引内でまとめて構築する。
    // 他の接続には、索引を戻した後の確定済みスキーマだけが見える。
    buildIndexes = nextSeq === 0;
    if (buildIndexes) db.exec("DROP INDEX fact_projection_dependency_lookup; DROP INDEX facts_subject_seq");
    const factSql = `INSERT INTO main.facts (seq, ${quotedColumns.join(", ")})
      SELECT p.seq, ${quotedColumns.map((name) => `f.${name}`).join(", ")}
      FROM staging.facts f JOIN pending_facts p ON p.staging_seq = f.seq`;
    const dependencySql = `INSERT OR IGNORE INTO main.fact_projection_dependencies
      SELECT d.projection, d.subject, d.direction, d.key, p.seq
      FROM staging.fact_projection_dependencies d JOIN pending_facts p ON p.staging_seq = d.seq`;
    // 事実の対応先の seq は準備側と同じ順序。既存の主キー順で読む。
    // 同じ SQL を周期ごとに準備すると、GC まで SQLite のネイティブ領域が積み上がる。
    copyFacts ??= db.prepare(`${factSql} ORDER BY f.seq`);
    copyDependencies ??= db.prepare(`${dependencySql} ORDER BY d.projection, d.subject, d.direction, d.key, d.seq`);
    copyFact ??= db.prepare(`${factSql} WHERE p.seq = ?`);
    copyDependency ??= db.prepare(`${dependencySql} WHERE p.seq = ?`);
    // 準備中の事実も予約済みの seq で読み、読み取りのための保存を繰り返さない。
    readBatch ??= db.prepare(`SELECT seq, ${quotedColumns.join(", ")} FROM main.facts WHERE seq > ?
      UNION ALL SELECT p.seq, ${quotedColumns.map((name) => `f.${name}`).join(", ")}
      FROM staging.facts f JOIN pending_facts p ON p.staging_seq = f.seq WHERE p.seq > ?
      ORDER BY seq LIMIT ?`);
  }
  function resetStaging(): void {
    stagingDb.exec("DELETE FROM fact_projection_dependencies; DELETE FROM facts");
    db.exec("DELETE FROM pending_facts");
    pending.clear();
    stagedCount = 0;
  }
  function persist(): void {
    if (pending.size === 0) { resetStaging(); return; }
    db.exec("SAVEPOINT copy_batch");
    try {
      copyFacts.run();
      copyDependencies.run();
      db.exec("RELEASE copy_batch");
    } catch {
      db.exec("ROLLBACK TO copy_batch; RELEASE copy_batch");
      // 一括保存に失敗した場合だけ逐次に戻し、成功した接頭辞と cursor を保持する。
      try {
        for (const { seq } of pending.values()) {
          db.exec("SAVEPOINT copy_fact");
          try { copyFact.run(seq); copyDependency.run(seq); db.exec("RELEASE copy_fact"); }
          catch (error) { db.exec("ROLLBACK TO copy_fact; RELEASE copy_fact"); throw error; }
        }
      } finally {
        resetStaging();
        nextSeq = Number(readSequence.get()?.seq ?? 0);
      }
      return;
    }
    resetStaging();
  }
  function commit(): void {
    try { persist(); }
    finally {
      if (buildIndexes) db.exec(`CREATE INDEX facts_subject_seq ON facts (subject, seq);
        CREATE INDEX fact_projection_dependency_lookup
        ON fact_projection_dependencies (projection, direction, key, subject, seq)`);
      db.exec("COMMIT; DETACH DATABASE staging");
    }
  }
  function flush(operation: () => void): void {
    if (!batching) { operation(); return; }
    try { commit(); operation(); }
    finally { begin(); }
  }
  function batch<T>(operation: () => T): T {
    if (batching) return operation();
    begin();
    batching = true;
    try { return operation(); }
    finally {
      // 中断時も成功済みの追記を確定し、次の走査で続きから補う。
      try { commit(); }
      finally { batching = false; }
    }
  }
  const ledger: BatchLedger = {
    ...base,
    batch,
    append(input: FactInput): AppendResult {
      return batch(() => {
        if (stagedCount >= STAGING_FACT_LIMIT) persist();
        const prepared = staging.append(input);
        stagedCount += 1;
        const payloadHash = prepared.status === "conflict" ? prepared.incoming_payload_hash
          : String(preparedHash.get(prepared.seq)!.payload_hash);
        const buffered = pending.get(prepared.fact_id);
        const stored = existing.get(input.source, input.source_event_id);
        const row = buffered ?? stored;
        if (row) {
          const identity = { seq: Number(row.seq), fact_id: buffered ? prepared.fact_id : String(stored!.fact_id) };
          const previousHash = buffered?.payloadHash ?? String(stored!.payload_hash);
          return previousHash === payloadHash ? { status: "duplicate", ...identity }
            : { status: "conflict", ...identity, existing_payload_hash: previousHash, incoming_payload_hash: payloadHash };
        }
        nextSeq += 1;
        reserve.run(prepared.seq, nextSeq);
        pending.set(prepared.fact_id, { seq: nextSeq, payloadHash });
        return { status: "appended", seq: nextSeq, fact_id: prepared.fact_id };
      });
    },
    readSince(seq, limit) {
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError("seq と limit は非負の安全な整数で指定してください");
      }
      return (batching ? readBatch.all(seq, seq, limit) : read.all(seq, limit)).map((row) => ({ ...row,
        payload: row.payload === null ? null : JSON.parse(String(row.payload)),
      } as Fact));
    },
    close() { stagingDb.close(); db.close(); staging.close(); base.close(); },
  };
  return { ledger, batch, flush, checkpoint() { db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } };
}
