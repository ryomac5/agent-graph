import type { JsonValue } from "./facts.ts";
type Row = { [key: string]: JsonValue };

function readObject(value: JsonValue | undefined): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Codex の turn_context に書かれたモデルと effort を読む。 */
export function readCodexTurnModel(row: Row): { model?: string; effort?: string } {
  if (row.type !== "turn_context") return {};
  const payload = readObject(row.payload);
  const model = readText(payload.model);
  const effort = readText(payload.effort) ?? readText(readObject(payload.reasoning).effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
