import { sendJson, type Route } from "../route.ts";
import { buildProjectView } from "../views.ts";

// GET /api/project?repo=<key> → ProjectView。1 リポジトリの全体。
export const projectRoute: Route = {
  method: "GET", path: "/api/project",
  handle: ({ options, url, response }) => {
    const key = url.searchParams.get("repo");
    if (key === null || !key) { sendJson(response, 400, { error: "repo query is required" }); return; }
    const store = options.openStores.get(key);
    const view = store && buildProjectView(store, key);
    if (!view) { sendJson(response, 404, { error: "Repository not found" }); return; }
    sendJson(response, 200, view);
  },
};
