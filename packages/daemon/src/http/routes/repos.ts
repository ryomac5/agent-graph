import { sendJson, type Route } from "../route.ts";

// 互換のため残す。一覧は GET /api/overview へ移る。
export const reposRoute: Route = {
  method: "GET", path: "/api/repos",
  handle: ({ options, response }) => { sendJson(response, 200, options.listRepos()); },
};
