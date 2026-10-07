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
export const FILE_COMMANDS = ["files.list", "files.read", "files.worktrees"] as const;
export type { FilesRequest, FileEntry, GitMark } from "../files/index.ts";
export type { ProjectionPatch, ProjectionRows } from "../service/projection-feed.ts";

// 成果物 ID は操作の間も固定し、再送時には同じ cmd_id を保つ。
export const REVIEW_COMMANDS = [
  "review.add_finding", "review.send", "review.reverify", "review.finding_state",
  "review.relation_target", "review.approve", "review.revoke", "review.start", "review.correct_relation",
] as const;
export interface ReviewCommand extends ScreenCommand {
  command: typeof REVIEW_COMMANDS[number];
}
