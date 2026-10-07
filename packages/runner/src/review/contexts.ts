import { createHash } from "node:crypto";
import type { FindingContext } from "../../../core/src/ledger/projections/findings.ts";

const CONTEXT_RADIUS = 2;
// 行番号を含めず、同じ側の前後の内容だけを位置の証拠にする。
function collectRanges(patch: string, width: number): { context: FindingContext; lines: string[] }[] {
  const ranges: { context: FindingContext; lines: string[] }[] = [];
  let file = "";
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  let rows: { text: string; old?: number; new?: number }[] = [];
  function flush(): void {
    for (const side of ["old", "new"] as const) {
      const lines = rows.filter((row) => row[side] !== undefined);
      for (let index = 0; index + width <= lines.length; index += 1) {
        const selected = lines.slice(index, index + width);
        if (selected.at(-1)![side]! - selected[0][side]! !== width - 1) continue;
        ranges.push({ lines: selected.map((line) => line.text), context: { file, side, start_line: selected[0][side]!, end_line: selected.at(-1)![side]!,
          context_hash: createHash("sha256").update(JSON.stringify([
            lines.slice(Math.max(0, index - CONTEXT_RADIUS), index).map((line) => line.text),
            lines.slice(index + width, index + width + CONTEXT_RADIUS).map((line) => line.text),
          ])).digest("hex") } });
      }
    }
    rows = [];
  }
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); file = ""; inHunk = false; }
    else if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path !== "/dev/null") file = path.startsWith('"') ? JSON.parse(path).slice(2) : path.replace(/^b\//, "");
    } else if (!inHunk && line.startsWith("--- ") && !file) {
      const path = line.slice(4);
      if (path !== "/dev/null") file = path.startsWith('"') ? JSON.parse(path).slice(2) : path.replace(/^a\//, "");
    } else if (line.startsWith("@@ ")) {
      flush();
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      inHunk = Boolean(match);
      if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
    } else if (file && inHunk && /^[ +\-]/.test(line)) {
      rows.push({ text: line.slice(1), ...(line[0] !== "+" ? { old: oldLine++ } : {}),
        ...(line[0] !== "-" ? { new: newLine++ } : {}) });
    }
  }
  flush();
  return ranges;
}

export function collectContexts(patch: string, width = 1): FindingContext[] {
  return collectRanges(patch, width).map((range) => range.context);
}

export function readFindingLines(patch: string, location: Pick<FindingContext, "file" | "side" | "start_line" | "end_line">): string[] | undefined {
  const matches = collectRanges(patch, location.end_line - location.start_line + 1).filter(({ context }) =>
    context.file === location.file && context.side === location.side
    && context.start_line === location.start_line && context.end_line === location.end_line);
  return matches.length === 1 ? matches[0].lines : undefined;
}
