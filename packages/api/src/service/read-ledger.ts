import { DatabaseSync } from "node:sqlite";
import { openLedger, type Fact, type Ledger } from "../../../core/src/ledger/index.ts";

export function openReadLedger(path: string) {
  // worker の起動前にだけスキーマを用意する。常駐中の台帳接続は読み取り専用。
  const initialization = openLedger(path);
  // 接続を閉じた後も、core の取得口から独立した秘匿規則を返す。
  const getRedactionRules = initialization.getRedactionRules;
  initialization.close();
  const db = new DatabaseSync(path, { readOnly: true });
  const read = db.prepare("SELECT * FROM facts WHERE seq > ? ORDER BY seq LIMIT ?");
  function rejectWrite(): never { throw new Error("Ledger writes belong to the observation worker"); }
  const ledger: Ledger = {
    getRedactionRules,
    append: rejectWrite, purgePayloads: rejectWrite, prunePayloads: rejectWrite,
    readSince(seq, limit) {
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError("seq と limit は非負の安全な整数で指定してください");
      }
      return read.all(seq, limit).map((row) => ({ ...row,
        payload: row.payload === null ? null : JSON.parse(String(row.payload)),
      } as Fact));
    },
    close() { db.close(); },
  };
  return { ledger, batch: <T>(_operation: () => T): T => rejectWrite(), checkpoint: rejectWrite };
}
