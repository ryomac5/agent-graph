export const VERSION_CHECK_MS = 30_000;
export const RELOAD_IDLE_MS = 5_000;
const RELOAD_RETRY_MS = 1_000;
const VERSION_TIMEOUT_MS = 10_000;
const RELOAD_STORAGE_KEY = 'agent-graph-reloaded-entries';

function readEntry(document: Document): string | null {
  return document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
}

export function installPreloadRecovery(reload = () => window.location.reload(), options: {
  isBlocked?: () => boolean;
  subscribeConnected?: (listener: () => void) => () => void;
} = {}) {
  const entry = readEntry(document);
  let checking = false, disposed = false, reloading = false, composing = false;
  let pointerDown = false;
  let lastActivity = Date.now();
  let nextEntry: string | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;

  function tryReload() {
    if (disposed || reloading || !nextEntry) return;
    if (composing || pointerDown || options.isBlocked?.()
      || !document.hidden && (document.hasFocus() || Date.now() - lastActivity < RELOAD_IDLE_MS)) {
      retry = setTimeout(tryReload, RELOAD_RETRY_MS);
      return;
    }
    try {
      // 同じ版への再試行は、読み直し後も禁止する。保存できなければ読み直さない。
      const entries: unknown = JSON.parse(sessionStorage.getItem(RELOAD_STORAGE_KEY) ?? '[]');
      if (!Array.isArray(entries) || entries.some(value => typeof value !== 'string')) return;
      if (entries.includes(nextEntry)) return;
      sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify([...entries, nextEntry]));
      reloading = true;
      reload();
    } catch { /* 保存できない場合も、現在の画面は使い続けられる。 */ }
  }
  async function check() {
    if (checking || disposed || reloading || !entry || navigator.onLine === false) return;
    checking = true;
    request = new AbortController();
    const timeout = setTimeout(() => request?.abort(), VERSION_TIMEOUT_MS);
    try {
      // 入口のファイル名を版として使い、api を再起動しない build も検知する。
      const response = await fetch(window.location.href, { cache: 'no-store', signal: request.signal });
      if (!response.ok) return;
      const next = readEntry(new DOMParser().parseFromString(await response.text(), 'text/html'));
      if (disposed) return;
      nextEntry = next && next !== entry ? next : null;
      clearTimeout(retry);
      if (nextEntry) retry = setTimeout(tryReload, RELOAD_RETRY_MS);
    } catch { /* 配信の入れ替え中や通信の失敗は次の確認で再試行する。 */ }
    finally { clearTimeout(timeout); request = undefined; checking = false; }
  }
  const activity = () => { lastActivity = Date.now(); };
  const startComposition = () => { composing = true; activity(); };
  const endComposition = () => { composing = false; activity(); };
  const startPointer = () => { pointerDown = true; activity(); };
  const endPointer = () => { pointerDown = false; activity(); };
  const visibility = () => { if (!document.hidden) activity(); void check(); };
  const activityEvents = ['keydown', 'keyup', 'beforeinput', 'input', 'paste', 'cut', 'pointermove', 'wheel', 'focusin'];
  for (const event of activityEvents) window.addEventListener(event, activity, true);
  window.addEventListener('compositionstart', startComposition, true);
  window.addEventListener('compositionend', endComposition, true);
  window.addEventListener('pointerdown', startPointer, true);
  window.addEventListener('pointerup', endPointer, true);
  window.addEventListener('pointercancel', endPointer, true);
  window.addEventListener('vite:preloadError', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', visibility);
  const unsubscribe = options.subscribeConnected?.(check);
  const interval = setInterval(check, VERSION_CHECK_MS);
  void check();
  return () => {
    disposed = true; request?.abort(); clearInterval(interval); clearTimeout(retry); unsubscribe?.();
    for (const event of activityEvents) window.removeEventListener(event, activity, true);
    window.removeEventListener('compositionstart', startComposition, true);
    window.removeEventListener('compositionend', endComposition, true);
    window.removeEventListener('pointerdown', startPointer, true);
    window.removeEventListener('pointerup', endPointer, true);
    window.removeEventListener('pointercancel', endPointer, true);
    window.removeEventListener('vite:preloadError', check);
    window.removeEventListener('online', check);
    document.removeEventListener('visibilitychange', visibility);
  };
}
