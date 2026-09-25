import { notImplemented, type Route } from "../route.ts";

// GET /api/project?repo=<key> → ProjectView。組み立ては後続のタスクが実装する。
export const projectRoute: Route = { method: "GET", path: "/api/project", handle: notImplemented };
