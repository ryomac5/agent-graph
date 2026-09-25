import { buildGraph, diffGraph } from "../graph.ts";
import { sendEvent, sendJson, type Route } from "../route.ts";

const KEEP_ALIVE_MS = 15_000;
const POLL_MS = 500;

// SSE。契約では repo ごとに event: project、省略時に event: overview を送る。
// 全体の組み立ては後続のタスクが views.ts に置く。それまでは従来の snapshot と delegation を送る。
export const eventsRoute: Route = {
  method: "GET", path: "/api/events",
  handle: ({ options, url, response }) => {
    const key = url.searchParams.get("repo");
    if (key === null) { sendJson(response, 501, { error: "event: overview is not implemented yet" }); return; }
    const store = options.openStores.get(key);
    if (!store) { sendJson(response, 404, { error: "Repository not found" }); return; }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache", connection: "keep-alive" });
    response.flushHeaders();
    const graph = () => buildGraph(store.db);
    let previous = graph();
    sendEvent(response, "snapshot", previous);
    const emit = (): void => {
      const next = graph();
      for (const change of diffGraph(previous, next)) sendEvent(response, "delegation", change);
      previous = next;
    };
    const unsubscribe = store.onChange(emit);
    const poll = setInterval(emit, POLL_MS);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
    response.once("close", () => { unsubscribe(); clearInterval(poll); clearInterval(keepAlive); });
  },
};
