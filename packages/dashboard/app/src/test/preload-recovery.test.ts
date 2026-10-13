import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreloadRecovery, RELOAD_IDLE_MS, VERSION_CHECK_MS } from '../lib/preload-recovery.ts';
import { holdDashboardReload, isDashboardReloadBlocked } from '../lib/reload-safety.ts';

let dispose = () => {};
beforeEach(() => {
  sessionStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(100_000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.head.innerHTML = '<script type="module" src="/assets/old.js"></script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' })));
});
afterEach(() => { dispose(); document.head.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const event = (name: string) => window.dispatchEvent(new Event(name, { bubbles: true }));
function install(options: Parameters<typeof installPreloadRecovery>[1] = {}) {
  const reload = vi.fn(); dispose = installPreloadRecovery(reload, options); return reload;
}
it('reloads each changed entry only once, including after reload and a later version', async () => {
  const reload = install();
  await advance(RELOAD_IDLE_MS); expect(reload).toHaveBeenCalledTimes(1);
  event('vite:preloadError'); await advance(VERSION_CHECK_MS * 2); expect(reload).toHaveBeenCalledTimes(1);
  dispose(); dispose = installPreloadRecovery(reload);
  await advance(VERSION_CHECK_MS * 2); expect(reload).toHaveBeenCalledTimes(1);
  vi.mocked(fetch).mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/third.js"></script>' } as Response);
  event('vite:preloadError'); await advance(RELOAD_IDLE_MS); expect(reload).toHaveBeenCalledTimes(2);
  dispose(); dispose = installPreloadRecovery(reload);
  vi.mocked(fetch).mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' } as Response);
  await advance(VERSION_CHECK_MS * 2); expect(reload).toHaveBeenCalledTimes(2);
});
it('detects build-only changes by polling the uncached HTML', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, text: async () => document.head.innerHTML } as Response);
  const reload = install();
  await advance(VERSION_CHECK_MS - 1); expect(reload).not.toHaveBeenCalled();
  await advance(RELOAD_IDLE_MS); expect(reload).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(window.location.href, { cache: 'no-store', signal: expect.any(AbortSignal) });
});
it('checks immediately on connection and reconnection and removes the subscription', async () => {
  let connected = () => {}; const unsubscribe = vi.fn();
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, text: async () => document.head.innerHTML } as Response);
  const reload = install({ subscribeConnected: listener => { connected = listener; return unsubscribe; } });
  await advance(RELOAD_IDLE_MS); expect(reload).not.toHaveBeenCalled();
  connected(); await advance(1000); expect(reload).toHaveBeenCalledTimes(1);
  dispose(); expect(unsubscribe).toHaveBeenCalledTimes(1);
});
it.each(['keydown', 'input', 'beforeinput', 'paste', 'pointermove', 'wheel'])('waits five seconds after %s activity', async name => {
  const reload = install();
  await advance(4000); event(name); await advance(4000); expect(reload).not.toHaveBeenCalled();
  event(name); await advance(RELOAD_IDLE_MS - 1); expect(reload).not.toHaveBeenCalled();
  await advance(1); expect(reload).toHaveBeenCalledTimes(1);
});
it('never reloads during IME composition, including in a hidden tab', async () => {
  const reload = install(); event('compositionstart');
  await advance(RELOAD_IDLE_MS * 2); expect(reload).not.toHaveBeenCalled();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  await advance(RELOAD_IDLE_MS); expect(reload).not.toHaveBeenCalled();
  event('compositionend'); await advance(1000); expect(reload).toHaveBeenCalledTimes(1);
});
it('waits for a pointer drag to finish', async () => {
  const reload = install(); event('pointerdown');
  await advance(RELOAD_IDLE_MS * 2); expect(reload).not.toHaveBeenCalled();
  event('pointerup'); await advance(RELOAD_IDLE_MS); expect(reload).toHaveBeenCalledTimes(1);
});
it('reloads a hidden tab without waiting for inactivity but still waits for all sends', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  const releaseFirst = holdDashboardReload(), releaseSecond = holdDashboardReload();
  const reload = install({ isBlocked: isDashboardReloadBlocked });
  try {
    await advance(1000); expect(reload).not.toHaveBeenCalled();
    releaseFirst(); releaseFirst(); await advance(1000); expect(reload).not.toHaveBeenCalled();
    releaseSecond(); await advance(1000); expect(reload).toHaveBeenCalledTimes(1);
  } finally { releaseFirst(); releaseSecond(); }
});
it.each(['same', 'missing', 'offline', 'failed'])('does not reload on %s entry or connection failure', async kind => {
  vi.mocked(fetch).mockImplementation(async () => {
    if (kind === 'offline') throw new Error('Offline');
    return { ok: kind !== 'failed', text: async () => kind === 'missing' ? '<html></html>' : '<script type="module" src="/assets/old.js"></script>' } as Response;
  });
  const reload = install(); await advance(VERSION_CHECK_MS * 2); expect(reload).not.toHaveBeenCalled();
});
it('cancels a pending reload when the server returns to the loaded version', async () => {
  let blocked = true; const reload = install({ isBlocked: () => blocked });
  await advance(RELOAD_IDLE_MS);
  vi.mocked(fetch).mockResolvedValue({ ok: true, text: async () => document.head.innerHTML } as Response);
  event('vite:preloadError'); await advance(0); blocked = false;
  await advance(RELOAD_IDLE_MS); expect(reload).not.toHaveBeenCalled();
});
it('does not reload or lose the draft when storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const reload = install(); await advance(RELOAD_IDLE_MS); expect(reload).not.toHaveBeenCalled();
});
it('does not overlap checks and aborts a stalled request before retrying', async () => {
  vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const reload = install(); event('vite:preloadError'); event('online');
  await advance(10_000); expect(fetch).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled();
  event('online'); await advance(1000); expect(reload).toHaveBeenCalledTimes(1);
});
it('cancels polling and pending reloads on disposal', async () => {
  const reload = install(); await advance(0); dispose();
  event('vite:preloadError'); event('online'); await advance(VERSION_CHECK_MS * 2);
  expect(fetch).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled();
});
