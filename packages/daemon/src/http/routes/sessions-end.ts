import { notImplemented, type Route } from "../route.ts";

// POST /api/sessions/<id>/end。hook 用。終了の記録は後続のタスクが実装する。
export const sessionsEndRoute: Route = {
  method: "POST", path: /^\/api\/sessions\/([^/]+)\/end$/, auth: "loopback", handle: notImplemented,
};
