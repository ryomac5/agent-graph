import type { JsonValue } from "../../../core/src/ledger/facts.ts";
import type { PROJECTION_TABLES } from "../../../core/src/ledger/rebuild.ts";

export interface ScreenHello {
  type: "hello";
  seq: number;
  // HTTP snapshot の世代を返す。再構築後は seq だけでは整合を判定できない。
  generation?: number;
  scope?: { tables?: (typeof PROJECTION_TABLES)[number][] };
}
export interface ScreenCommand {
  type: "cmd";
  cmd_id: string;
  command: string;
  payload?: JsonValue;
}
export type ScreenInput = ScreenHello | ScreenCommand;
export type { ProjectionPatch, ProjectionRows } from "../service/projection-feed.ts";
