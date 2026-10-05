import { sendJson, type Route } from "../route.ts";
import { NotFoundError } from "../../sessions.ts";
import { sayToSession } from "../../say.ts";

const MAX_SAY_BODY_BYTES = 8192;

// POST /api/say: { repo, sessionId, text } → ActionResult。守りは server.ts が auth: token で通す。
// 不正な body は 400、未知の対象は 404、送れない状態は 409 で ok: false。
export const sayRoute: Route = {
  method: "POST", path: "/api/say", auth: "token",
  handle: async ({ options, response, readJson }) => {
    try {
      const result = await sayToSession(await readJson(MAX_SAY_BODY_BYTES), options.openStores);
      sendJson(response, result.ok ? 200 : 409, result);
    } catch (error) {
      if (error instanceof TypeError) { sendJson(response, 400, { error: error.message }); return; }
      if (error instanceof NotFoundError) { sendJson(response, 404, { error: error.message }); return; }
      throw error;
    }
  },
};
