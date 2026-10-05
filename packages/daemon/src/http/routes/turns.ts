import { sendJson, type Route } from "../route.ts";

const PAGE_SIZE = 50;
export const turnsRoute: Route = {
  method: "GET", path: "/api/turns",
  handle: ({ options, url, response }) => {
    const repo = url.searchParams.get("repo") || "";
    const sessionId = url.searchParams.get("session") || "";
    const before = url.searchParams.get("before");
    const store = options.openStores.get(repo);
    const session = store?.getSession(sessionId);
    if (!store || !session || session.repoKey !== repo) { sendJson(response, 404, { error: "Session not found" }); return; }
    const cursor = before ? store.db.prepare("SELECT rowid AS position, at FROM turns WHERE id = ? AND session_id = ?").get(before, sessionId) : undefined;
    if (before && !cursor) { sendJson(response, 400, { error: "Invalid history cursor" }); return; }
    const rows = store.db.prepare(`SELECT * FROM (SELECT rowid AS position, * FROM turns WHERE session_id = ?
      AND (at < ? OR (at = ? AND rowid < ?)) ORDER BY at DESC, rowid DESC LIMIT ?) ORDER BY at, position`)
      .all(sessionId, cursor ? String(cursor.at) : "9999", cursor ? String(cursor.at) : "9999", cursor ? Number(cursor.position) : Number.MAX_SAFE_INTEGER, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    sendJson(response, 200, { hasMore, turns: rows.slice(hasMore ? 1 : 0).map((row) => ({ id: String(row.id), at: String(row.at),
      prompt: String(row.prompt), ...(row.reply === null ? {} : { reply: String(row.reply) }),
      ...(row.summary === null ? {} : { summary: String(row.summary) }), hidden: row.hidden === 1 })) });
  },
};
