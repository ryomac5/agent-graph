export interface ReviewResult {
  verdict: "approve" | "request_changes";
  comment: string;
}

export function parseReviewResult(output: string): ReviewResult {
  let last: unknown;
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  // 前置きやフェンスを除き、文字列内の括弧を無視して最後の JSON を読む。
  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
    if (start === -1) {
      if (char !== "{") continue;
      start = index;
      depth = 1;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try { last = JSON.parse(output.slice(start, index + 1)); }
      catch { /* 説明文の括弧は JSON の候補から除く。 */ }
      start = -1;
    }
  }
  if (!last || typeof last !== "object" || Array.isArray(last)) throw new Error("Invalid review result");
  const review = last as Record<string, unknown>;
  if ((review.verdict !== "approve" && review.verdict !== "request_changes") || typeof review.comment !== "string") {
    throw new Error("Invalid review result");
  }
  return { verdict: review.verdict as ReviewResult["verdict"], comment: review.comment };
}
