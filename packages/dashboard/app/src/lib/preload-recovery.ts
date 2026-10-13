const RELOAD_INTERVAL_MS = 30_000;
const RELOAD_STORAGE_KEY = 'agent-graph-preload-reload';

function readEntry(document: Document): string | null {
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
}
export function installPreloadRecovery(reload = () => window.location.reload()) {
  const entry = readEntry(document);
  let checking = false;
  let disposed = false;
  const handleError = () => {
    if (checking || !entry || navigator.onLine === false) return;
    checking = true;
    // 分割ファイルの失敗だけでは更新と断定せず、配信中の入口を確かめる。
    void (async () => {
      try {
        const saved = sessionStorage.getItem(RELOAD_STORAGE_KEY);
        if (saved !== null && Date.now() - Number(saved) < RELOAD_INTERVAL_MS) return;
        const response = await fetch(window.location.href, { cache: 'no-store' });
        if (!response.ok) return;
        const next = readEntry(new DOMParser().parseFromString(await response.text(), 'text/html'));
        if (disposed || !next || next === entry) return;
        sessionStorage.setItem(RELOAD_STORAGE_KEY, String(Date.now()));
        reload();
      } catch { /* 通信や保存の失敗は画面内の復旧に任せる。 */ }
      finally { checking = false; }
    })();
  };
  window.addEventListener('vite:preloadError', handleError);
  return () => { disposed = true; window.removeEventListener('vite:preloadError', handleError); };
}
