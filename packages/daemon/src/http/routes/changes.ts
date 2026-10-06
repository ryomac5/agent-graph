import { listSessions } from "../../../../core/src/store/queries.ts";
import { buildChanges, type SessionRef } from "../../git-changes.ts";
import { sendJson, type Route } from "../route.ts";

const PAGE_SIZE = 40;
// プロジェクトの開発の流れ。既定のブランチのコミットと作業中のブランチに、作ったセッションを添える
export const changesRoute: Route = {
  method: "GET", path: "/api/changes",
  handle: async ({ options, url, response }) => {
    const repo = url.searchParams.get("repo") || "";
    const skip = Math.max(0, Number(url.searchParams.get("skip")) || 0);
    const store = options.openStores.get(repo);
    const root = store?.db.prepare("SELECT root_path FROM repos WHERE key = ?").get(repo)?.root_path;
    if (!store || typeof root !== "string") { sendJson(response, 404, { error: "Project not found" }); return; }
    const names = new Map<string, SessionRef>(listSessions(store.db, repo).map((session) => [session.id, { id: session.id, name: session.name, client: session.client, startedAt: session.startedAt }]));
    try {
      sendJson(response, 200, await buildChanges(root, store.listSessionCommands(repo), names, { limit: PAGE_SIZE, skip }));
    } catch (error) {
      sendJson(response, 422, { error: `Could not read git history: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
    }
  },
};
