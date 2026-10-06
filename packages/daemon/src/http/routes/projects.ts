import { addProject, pickFolder } from "../../projects.ts";
import { sendJson, type Route } from "../route.ts";

const MAX_BODY_BYTES = 4096;
// POST /api/projects。pick なら macOS のフォルダ選択を開き、path ならそのフォルダを追加する
export const projectsRoute: Route = {
  method: "POST", path: "/api/projects", auth: "token",
  handle: async ({ options, response, readJson }) => {
    const body = await readJson(MAX_BODY_BYTES) as { pick?: unknown; path?: unknown } | null;
    let path = typeof body?.path === "string" ? body.path.trim() : "";
    if (body?.pick === true) {
      let picked: string | undefined;
      try { picked = await pickFolder(); } catch (error) {
        sendJson(response, 500, { ok: false, message: `Could not open the folder picker: ${(error as Error).message.split("\n")[0]}` });
        return;
      }
      if (!picked) { sendJson(response, 200, { ok: false, cancelled: true, message: "Cancelled" }); return; }
      path = picked;
    }
    if (!path) { sendJson(response, 400, { ok: false, message: "No folder was given" }); return; }
    const result = await addProject(path, options.openStores);
    sendJson(response, result.ok ? 200 : 422, result);
  },
};
