import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installPreloadRecovery } from '../lib/preload-recovery.ts';

beforeEach(() => { sessionStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { vi.useRealTimers(); });
function dispatchFailure() {
  const event = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

it('reloads once in 30 seconds, preserving the limit after installing on a new page', () => {
  const reload = vi.fn();
  let dispose = installPreloadRecovery(reload);
  try {
    expect(dispatchFailure().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    dispose();
    dispose = installPreloadRecovery(reload);
    vi.advanceTimersByTime(29_999);
    expect(dispatchFailure().defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(dispatchFailure().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  } finally { dispose(); }
});

it('lets the boundary handle rejection when storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const reload = vi.fn();
  const dispose = installPreloadRecovery(reload);
  try {
    expect(dispatchFailure().defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  } finally { dispose(); }
});
