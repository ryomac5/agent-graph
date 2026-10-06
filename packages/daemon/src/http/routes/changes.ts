import { listSessions } from "../../../../core/src/store/queries.ts";
import { buildChanges, type SessionRef } from "../../git-changes.ts";
import { chainTails } from "../views.ts";
import { sendJson, type Route } from "../route.ts";

const PAGE_SIZE = 60;
// プロジェクトの開発の流れ。既定のブランチのコミットと作業中のブランチに、作ったセッションを添える
export const changesRoute: Route = {
  method: "GET", path: "/api/changes",
  handle: async ({ options, url, response }) => {
    const repo = url.searchParams.get("repo") || "";
    const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
    const store = options.openStores.get(repo);
    const root = store?.db.prepare("SELECT root_path FROM repos WHERE key = ?").get(repo)?.root_path;
    if (!store || typeof root !== "string") { sendJson(response, 404, { error: "Project not found" }); return; }
    // コミットは鎖のどの会話 ID で作っても、鎖の末尾の会話として札を付ける
    const sessions = listSessions(store.db, repo);
    const tails = chainTails(sessions);
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const names = new Map<string, SessionRef>(sessions.map((session) => {
      const tail = byId.get(tails.get(session.id) ?? session.id) ?? session;
      const first = sessions.filter((item) => (tails.get(item.id) ?? item.id) === tail.id).map((item) => item.startedAt).sort()[0] ?? tail.startedAt;
      return [session.id, { id: tail.id, name: tail.name || session.name, client: tail.client, startedAt: first }];
    }));
    try {
      sendJson(response, 200, await buildChanges(root, store.listSessionCommands(repo), names, { limit: PAGE_SIZE, skip }));
    } catch (error) {
      sendJson(response, 422, { error: `Could not read git history: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
    }
  },
};
