import { notImplemented, type Route } from "../route.ts";

// POST /api/observe。hook 用。turn などの観測は後続のタスクが実装する。
export const observeRoute: Route = { method: "POST", path: "/api/observe", auth: "loopback", handle: notImplemented };
