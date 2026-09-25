import { sendJson, type Route } from "../route.ts";
import { registerSession } from "../sessions.ts";

const MAX_SESSION_BODY_BYTES = 16_384;

// hook 用。接続元が 127.0.0.1 なら受ける。
export const sessionsRoute: Route = {
  method: "POST", path: "/api/sessions", auth: "loopback",
  handle: async ({ options, response, readJson }) => {
    try {
      await registerSession(await readJson(MAX_SESSION_BODY_BYTES), options.openStores);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      sendJson(response, 400, { error: error.message });
      return;
    }
    sendJson(response, 201, { ok: true });
  },
};
