import { sendJson, type Route } from "../route.ts";
import { endSession, NotFoundError } from "../../sessions.ts";

const MAX_END_BODY_BYTES = 4096;

// POST /api/sessions/<id>/end。hook の SessionEnd。body は {} でよい。
export const sessionsEndRoute: Route = {
  method: "POST", path: /^\/api\/sessions\/([^/]+)\/end$/, auth: "loopback",
  handle: async ({ options, response, params, readJson }) => {
    let id: string;
    try { id = decodeURIComponent(params[0]); }
    catch { sendJson(response, 400, { error: "Invalid session id" }); return; }
    const body = await readJson(MAX_END_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body)) { sendJson(response, 400, { error: "Invalid end body" }); return; }
    try { endSession(id, options.openStores); }
    catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      sendJson(response, 404, { error: error.message });
      return;
    }
    sendJson(response, 200, { ok: true });
  },
};
