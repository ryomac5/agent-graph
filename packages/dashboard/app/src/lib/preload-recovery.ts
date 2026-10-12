const RELOAD_INTERVAL_MS = 30_000;
const RELOAD_STORAGE_KEY = 'agent-graph-preload-reload';

export function installPreloadRecovery(reload = () => window.location.reload()) {
  const handleError = (event: Event) => {
    const now = Date.now();
    // 再読み込み後も制限を保つ。保存できない場合は画面内の復旧に任せる。
    try {
      const saved = sessionStorage.getItem(RELOAD_STORAGE_KEY);
      if (saved !== null && now - Number(saved) < RELOAD_INTERVAL_MS) return;
      sessionStorage.setItem(RELOAD_STORAGE_KEY, String(now));
    } catch { return; }
    event.preventDefault();
    reload();
  };
  window.addEventListener('vite:preloadError', handleError);
  return () => window.removeEventListener('vite:preloadError', handleError);
}
