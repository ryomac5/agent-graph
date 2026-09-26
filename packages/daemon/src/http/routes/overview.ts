import { sendJson, type Route } from "../route.ts";
import { buildOverview } from "../views.ts";

// GET /api/overview → Overview。全リポジトリの一覧と利用枠。
export const overviewRoute: Route = {
  method: "GET", path: "/api/overview",
  handle: ({ options, response }) => { sendJson(response, 200, buildOverview(options.openStores)); },
};
