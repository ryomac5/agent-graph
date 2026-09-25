import { buildGraph } from "../graph.ts";
import { sendJson, type Route } from "../route.ts";

// 互換のため残す。詳細は GET /api/project へ移る。
export const graphRoute: Route = {
  method: "GET", path: "/api/graph",
  handle: ({ options, url, response }) => {
    const key = url.searchParams.get("repo");
    const store = key === null ? undefined : options.openStores.get(key);
    if (!store) { sendJson(response, 404, { error: "Repository not found" }); return; }
    sendJson(response, 200, buildGraph(store.db, { session: url.searchParams.get("session") ?? undefined }));
  },
};
