import { sendJson, type Route } from "../route.ts";
import { performAction } from "../../actions.ts";
import { NotFoundError } from "../../sessions.ts";

const MAX_ACTION_BODY_BYTES = 4096;

// POST /api/action: ActionRequest → ActionResult。守りは server.ts が auth: token で通す。
// 不正な body は 400、未知の対象は 404、状態が合わないときは 409 で ok: false。
export const actionRoute: Route = {
  method: "POST", path: "/api/action", auth: "token",
  handle: async ({ options, response, readJson }) => {
    const body = await readJson(MAX_ACTION_BODY_BYTES);
    try {
      const result = performAction(body, options.openStores);
      sendJson(response, result.ok ? 200 : 409, result);
    } catch (error) {
      if (error instanceof TypeError) { sendJson(response, 400, { error: error.message }); return; }
      if (error instanceof NotFoundError) { sendJson(response, 404, { error: error.message }); return; }
      throw error;
    }
  },
};
