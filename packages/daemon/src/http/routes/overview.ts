import { notImplemented, type Route } from "../route.ts";

// GET /api/overview → Overview。組み立ては後続のタスクが実装する。
export const overviewRoute: Route = { method: "GET", path: "/api/overview", handle: notImplemented };
