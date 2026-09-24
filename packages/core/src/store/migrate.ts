import type { DatabaseSync } from "node:sqlite";
import { migrations, type Migration } from "./migrations.ts";

export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations): void {
  const ordered = [...steps].sort((left, right) => left.version - right.version);
  const versions = new Set<number>();
  for (const step of ordered) {
    if (!Number.isSafeInteger(step.version) || step.version <= 0 || versions.has(step.version)) {
      throw new TypeError("Migration versions must be unique positive integers");
    }
    versions.add(step.version);
  }

  for (const step of ordered) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const exists = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
      ).get();
      const current = exists
        ? Number(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()!.version ?? 0)
        : 0;
      if (step.version > current) {
        db.exec(step.sql);
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(step.version, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
