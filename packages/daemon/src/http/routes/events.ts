import type { Store } from "../../../../core/src/store/store.ts";
import { sendEvent, sendJson, type Route } from "../route.ts";
import { buildOverview, buildProjectView } from "../views.ts";

export const KEEP_ALIVE_MS = 15_000;
export const POLL_MS = 500;
export const THROTTLE_MS = 250;

// updatedAt を除いて比べる。時刻だけが進んだ全体は送らない。
function fingerprint(view: object): string {
  return JSON.stringify({ ...view, updatedAt: undefined });
}

// SSE。repo があれば event: project で ProjectView、無ければ event: overview で Overview の全体を送る。
// 変化は store の onChange と POLL_MS の見回りで捉え、THROTTLE_MS に 1 回まで最後の状態だけ送る。
export const eventsRoute: Route = {
  method: "GET", path: "/api/events",
  handle: ({ options, url, response }) => {
    const key = url.searchParams.get("repo");
    const store = key === null ? undefined : options.openStores.get(key);
    const build = key === null
      ? () => buildOverview(options.openStores)
      : () => (store ? buildProjectView(store, key) : undefined);
    const event = key === null ? "overview" : "project";
    const initial = build();
    if (!initial) { sendJson(response, 404, { error: "Repository not found" }); return; }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache", connection: "keep-alive" });
    response.flushHeaders();
    let last = fingerprint(initial);
    sendEvent(response, event, initial);

    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const send = (): void => {
      if (closed) return;
      let view: object | undefined;
      try { view = build(); }
      catch { response.end(); return; }
      if (!view) { response.end(); return; }
      const next = fingerprint(view);
      if (next === last) return;
      last = next;
      sendEvent(response, event, view);
    };
    const schedule = (): void => {
      if (timer || closed) return;
      timer = setTimeout(() => { timer = undefined; send(); }, THROTTLE_MS);
    };
    // repo 省略時はすべての store を見る。あとから開いた store は見回りで拾う。
    const watched = new Map<Store, () => void>();
    const watch = (): void => {
      for (const target of store ? [store] : options.openStores.values()) {
        if (!watched.has(target)) watched.set(target, target.onChange(schedule));
      }
    };
    watch();
    const poll = setInterval(() => { watch(); schedule(); }, POLL_MS);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), KEEP_ALIVE_MS);
    response.once("close", () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const unsubscribe of watched.values()) unsubscribe();
      clearInterval(poll);
      clearInterval(keepAlive);
    });
  },
};
