// SSE の /api/events で全体を受けて描き直す。切れたら 2 秒おきに再接続し、その間は 2 秒おきに取る
export const RETRY_MS = 2000;

// key が空なら Overview、あれば ProjectView。
// onData(data)、onState("live" | "offline" | "connecting")、onError(message) は取得の失敗の理由。
// deps は fetch, EventSource, setTimeout, clearTimeout を差し替える。テストは偽のタイマーを渡す
export function openFeed(key, { onData, onState, onError }, deps = {}) {
  const fetchFn = deps.fetch || ((...args) => globalThis.fetch(...args));
  const Source = deps.EventSource === undefined ? globalThis.EventSource : deps.EventSource;
  const setTimer = deps.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || ((id) => globalThis.clearTimeout(id));
  const query = key ? `?repo=${encodeURIComponent(key)}` : "";
  const eventName = key ? "project" : "overview";
  const restUrl = key ? `/api/project${query}` : "/api/overview";
  let source = null;
  let closed = false;
  let live = false;
  let pollTimer = 0;
  let retryTimer = 0;
  // 飛んでいる fetch は 1 つだけ。世代で古い結果を捨てる
  let inFlight = false;
  let generation = 0;

  const fail = (message) => { onState("offline"); if (onError) onError(message); };

  // 2 秒おきに REST で取る。先に予約を消し、同時に 2 つ走らせない
  const poll = async () => {
    clearTimer(pollTimer);
    pollTimer = 0;
    if (closed || live || inFlight) return;
    inFlight = true;
    const started = generation;
    try {
      const res = await fetchFn(restUrl, { cache: "no-store" });
      if (closed || live || started !== generation) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (closed || live || started !== generation) return;
      onData(data);
    } catch (error) {
      if (!closed && !live && started === generation) fail(error && error.message ? error.message : String(error));
    } finally {
      inFlight = false;
      if (!closed && !live) startPolling();
    }
  };
  const startPolling = () => {
    clearTimer(pollTimer);
    pollTimer = 0;
    if (closed || live) return;
    pollTimer = setTimer(poll, RETRY_MS);
  };
  const stopPolling = () => { clearTimer(pollTimer); pollTimer = 0; };

  const connect = () => {
    clearTimer(retryTimer);
    retryTimer = 0;
    if (closed) return;
    if (typeof Source !== "function") { return; }
    onState("connecting");
    source = new Source(`/api/events${query}`);
    source.addEventListener("open", () => {
      // 接続が戻ったら飛んでいる fetch の結果を捨て、ポーリングを止める
      live = true;
      generation += 1;
      stopPolling();
      onState("live");
    });
    source.addEventListener(eventName, (ev) => {
      live = true;
      generation += 1;
      stopPolling();
      try { onData(JSON.parse(ev.data)); } catch { /* 壊れた行は捨てる */ }
    });
    source.addEventListener("error", () => {
      // 未実装の 501 や切断。閉じて 2 秒おきに繋ぎ直し、その間は REST で取る
      live = false;
      if (source) source.close();
      source = null;
      onState("offline");
      startPolling();
      clearTimer(retryTimer);
      retryTimer = setTimer(connect, RETRY_MS);
    });
  };
  void poll();
  connect();
  return {
    close() {
      closed = true;
      stopPolling();
      clearTimer(retryTimer);
      retryTimer = 0;
      if (source) source.close();
      source = null;
    },
    get live() { return live; },
  };
}
