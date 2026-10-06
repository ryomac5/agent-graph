import { modelCatalog } from "../../models.ts";
import { sendJson, type Route } from "../route.ts";

// 変更できるモデルと effort の一覧。ダッシュボードのモデルの切り替えが使う
export const modelsRoute: Route = {
  method: "GET", path: "/api/models",
  handle: ({ response }) => { sendJson(response, 200, modelCatalog()); },
};
