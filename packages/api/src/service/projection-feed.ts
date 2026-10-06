import { DatabaseSync } from "node:sqlite";
import { PROJECTION_TABLES, type ProjectionState } from "../../../core/src/ledger/rebuild.ts";

export type ProjectionRows = Record<string, Record<string, unknown>[]>;
export interface ProjectionPatch {
  type: "patch"; from_seq: number; seq: number; generation: number;
  changes: Record<string, { upsert: Record<string, unknown>[]; remove: string[] }>;
}
const PATCH_RETENTION = 1000;
export class ProjectionFeed {
  private db: DatabaseSync;
  private catchUp: () => ProjectionState;
  private state: ProjectionState;
  private rows: ProjectionRows;
  private history: ProjectionPatch[] = [];
  private floor: number;
  private limit: number;
  private requiresGeneration: boolean;
  constructor(path: string, catchUp: () => ProjectionState, limit = PATCH_RETENTION) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid patch retention");
    this.state = catchUp();
    this.requiresGeneration = this.state.generation > 0;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.catchUp = catchUp;
    this.limit = limit;
    this.rows = this.readRows();
    this.floor = this.state.last_seq;
  }
  private readRows(): ProjectionRows {
    return Object.fromEntries(PROJECTION_TABLES.map((table) => [table, this.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  }
  refresh(): ProjectionPatch | "resync" | undefined {
    const state = this.catchUp();
    if (state.generation === this.state.generation && state.last_seq === this.state.last_seq) return;
    const rows = this.readRows();
    if (state.generation !== this.state.generation || state.last_seq < this.state.last_seq) {
      this.state = state;
      this.rows = rows;
      this.history = [];
      this.requiresGeneration = true;
      this.floor = state.last_seq;
      return "resync";
    }
    const patch: ProjectionPatch = { type: "patch", from_seq: this.state.last_seq,
      seq: state.last_seq, generation: state.generation, changes: {} };
    for (const table of PROJECTION_TABLES) {
      const previous = new Map(this.rows[table].map((row) => [String(row.id), row]));
      const upsert = rows[table].filter((row) => JSON.stringify(previous.get(String(row.id))) !== JSON.stringify(row));
      const current = new Set(rows[table].map((row) => String(row.id)));
      const remove = [...previous.keys()].filter((id) => !current.has(id));
      if (upsert.length || remove.length) patch.changes[table] = { upsert, remove };
    }
    this.state = state;
    this.rows = rows;
    this.history.push(patch);
    if (this.history.length > this.limit) this.floor = this.history.shift()!.seq;
    return patch;
  }
  replay(seq: number, generation?: number): ProjectionPatch[] | undefined {
    // 再構築後は snapshot の世代を hello で返し、同じ seq の古い投影を区別する。
    if (this.requiresGeneration && generation === undefined) return;
    if (seq < this.floor || seq > this.state.last_seq || generation !== undefined && generation !== this.state.generation) return;
    // バッチ途中からの再送は冪等な upsert/remove で最終状態へ収束する。
    return this.history.filter((patch) => patch.seq > seq);
  }
  snapshot() { return { seq: this.state.last_seq, generation: this.state.generation, projection: this.rows }; }
  close(): void { this.db.close(); }
}
