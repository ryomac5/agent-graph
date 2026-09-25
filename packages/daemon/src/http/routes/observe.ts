import { sendJson, type Route } from "../route.ts";
import { NotFoundError } from "../../sessions.ts";
import { observe } from "../../observe.ts";

const MAX_OBSERVE_BODY_BYTES = 262_144;

// POST /api/observe。hook の turn と待ちとサブエージェントの観測。種類ごとの取り込みは observe.ts の observers にある。
export const observeRoute: Route = {
  method: "POST", path: "/api/observe", auth: "loopback",
  handle: async ({ options, response, readJson }) => {
    try { observe(await readJson(MAX_OBSERVE_BODY_BYTES), options.openStores); }
    catch (error) {
      if (error instanceof TypeError) { sendJson(response, 400, { error: error.message }); return; }
      if (error instanceof NotFoundError) { sendJson(response, 404, { error: error.message }); return; }
      throw error;
    }
    sendJson(response, 200, { ok: true });
  },
};
