import { commitDiff } from "../../git-diff.ts";
import { sendJson, type Route } from "../route.ts";

// 1 つのコミットの差分。Changes のコミットを押したときに右の詳細で出す
export const diffRoute: Route = {
  method: "GET", path: "/api/diff",
  handle: async ({ options, url, response }) => {
    const repo = url.searchParams.get("repo") || "";
    const sha = url.searchParams.get("sha") || "";
    const store = options.openStores.get(repo);
    const root = store?.db.prepare("SELECT root_path FROM repos WHERE key = ?").get(repo)?.root_path;
    if (!store || typeof root !== "string") { sendJson(response, 404, { error: "Project not found" }); return; }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) { sendJson(response, 400, { error: "Invalid commit" }); return; }
    try { sendJson(response, 200, await commitDiff(root, sha)); }
    catch (error) {
      sendJson(response, 422, { error: `Could not read the diff: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` });
    }
  },
};
