import { notImplemented, type Route } from "../route.ts";

// POST /api/action: ActionRequest → ActionResult。判断の受け渡しは後続のタスクが実装する。
export const actionRoute: Route = { method: "POST", path: "/api/action", auth: "token", handle: notImplemented };
