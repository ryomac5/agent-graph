// SSE の /api/events で全体を受けて描き直す。切れたら 2 秒おきに再接続し、その間は 2 秒おきに取る
export const RETRY_MS = 2000;

// key が空なら Overview、あれば ProjectView。onData(data) と onState("live" | "offline" | "connecting")
export function openFeed(key, { onData, onState }) {
  const query = key ? `?repo=${encodeURIComponent(key)}` : "";
  const eventName = key ? "project" : "overview";
  const restUrl = key ? `/api/project${query}` : "/api/overview";
  let source = null;
  let closed = false;
  let pollTimer = 0;
  let retryTimer = 0;
  let live = false;

  const poll = async () => {
    if (closed || live) return;
    try {
      const res = await fetch(restUrl, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onData(await res.json());
    } catch { onState("offline"); }
    if (!closed && !live) pollTimer = setTimeout(poll, RETRY_MS);
  };
  const startPolling = () => { clearTimeout(pollTimer); if (!closed && !live) pollTimer = setTimeout(poll, RETRY_MS); };

  const connect = () => {
    if (closed || typeof EventSource !== "function") { poll(); return; }
    onState("connecting");
    source = new EventSource(`/api/events${query}`);
    source.addEventListener("open", () => { live = true; clearTimeout(pollTimer); onState("live"); });
    source.addEventListener(eventName, (ev) => {
      live = true;
      try { onData(JSON.parse(ev.data)); } catch { /* 壊れた行は捨てる */ }
    });
    source.addEventListener("error", () => {
      // 未実装の 501 や切断。閉じて 2 秒おきに繋ぎ直し、その間は REST で取る
      live = false;
      source.close();
      source = null;
      onState("offline");
      poll();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, RETRY_MS);
    });
  };
  poll();
  connect();
  return {
    close() {
      closed = true;
      clearTimeout(pollTimer);
      clearTimeout(retryTimer);
      if (source) source.close();
    },
    startPolling,
  };
}
