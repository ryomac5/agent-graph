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

export interface ReviewSubject {
  request: { title: string; task: string; accept: string[]; scope?: string[] };
  reply: string;
  artifact: object;
}

// レビュアーは依頼の文脈がなければ空の差分を未実装と読むため、元の依頼と実装者の返答を必ず渡す。
export function buildReviewPrompt({ request, reply, artifact }: ReviewSubject): string {
  return [
    "Review a delegated task. Do not edit files.",
    "Judge the fixed artifact and the implementer reply against the original request below.",
    "Approve when they do what the task asks, stay within the scope, and the verification passed.",
    "An empty diff is correct when the task asks for no file changes.",
    "Request changes when required work is missing, the change goes beyond the task or scope, or the result is wrong.",
    'Return one JSON object with "verdict" ("approve" or "request_changes") and "comment".',
    "",
    "Original request:",
    JSON.stringify({ title: request.title, task: request.task, accept: request.accept, ...(request.scope ? { scope: request.scope } : {}) }),
    "",
    "Implementer reply:",
    reply,
    "",
    "Fixed artifact:",
    JSON.stringify(artifact),
  ].join("\n");
}
