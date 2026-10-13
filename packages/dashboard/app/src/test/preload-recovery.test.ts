import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreloadRecovery } from '../lib/preload-recovery.ts';

beforeEach(() => {
  sessionStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(100_000);
  document.head.innerHTML = '<script type="module" src="/assets/old.js"></script>';
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<script type="module" src="/assets/new.js"></script>' })));
});
afterEach(() => { document.head.innerHTML = ''; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function dispatchFailure() {
  window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await Promise.resolve(); await Promise.resolve();
}
it('reloads a changed entry once in 30 seconds, retaining the limit across pages', async () => {
  const reload = vi.fn();
  let dispose = installPreloadRecovery(reload);
  try {
    await dispatchFailure(); expect(reload).toHaveBeenCalledTimes(1);
    dispose(); dispose = installPreloadRecovery(reload);
    vi.advanceTimersByTime(29_999);
    await dispatchFailure(); expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await dispatchFailure(); expect(reload).toHaveBeenCalledTimes(2);
  } finally { dispose(); }
});
it.each(['same', 'missing', 'offline', 'failed'])('does not reload on %s entry or connection failure', async kind => {
  vi.mocked(fetch).mockImplementation(async () => {
    if (kind === 'offline') throw new Error('Offline');
    return { ok: kind !== 'failed', text: async () => kind === 'missing' ? '<html></html>' : '<script type="module" src="/assets/old.js"></script>' } as Response;
  });
  const reload = vi.fn(); const dispose = installPreloadRecovery(reload);
  try { await dispatchFailure(); expect(reload).not.toHaveBeenCalled(); } finally { dispose(); }
});
it('lets the boundary handle rejection when storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const reload = vi.fn(); const dispose = installPreloadRecovery(reload);
  try { await dispatchFailure(); expect(reload).not.toHaveBeenCalled(); } finally { dispose(); }
});
