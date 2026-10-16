import { expect, it, vi } from 'vitest';
import { createClient } from '../lib/client.ts';
import { createStore } from '../lib/store.ts';

it('refreshes rotating credentials before reconnect and uses them for WebSocket and snapshot', async () => {
  vi.useFakeTimers();
  const target = createStore();
  const sockets: WebSocket[] = [];
  const addresses: string[] = [];
  const fetchSnapshot = vi.fn(async (_url: URL, _options: RequestInit) => ({ ok: true, json: async () => ({ seq: 1, generation: 0, projection: {} }) }));
  vi.stubGlobal('fetch', fetchSnapshot);
  const refreshToken = vi.fn(async () => 'new-token');
  const client = createClient({ url: 'ws://localhost/ws', token: 'old-token', store: target, refreshToken,
    createSocket: address => {
      addresses.push(address);
      const socket = { readyState: 0, onopen: null, onclose: null, onerror: null, onmessage: null,
        send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
      sockets.push(socket);
      return socket;
    } });
  try {
    client.start();
    expect(refreshToken).not.toHaveBeenCalled();
    sockets[0].onclose?.(new CloseEvent('close'));
    await vi.advanceTimersByTimeAsync(500);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(new URL(addresses[1]).searchParams.get('token')).toBe('new-token');
    sockets[1].onopen?.(new Event('open'));
    await Promise.resolve();
    expect(fetchSnapshot.mock.calls[0]).toEqual([expect.any(URL), { headers: { 'x-agent-graph-token': 'new-token' } }]);
    expect(new URL(String(fetchSnapshot.mock.calls[0][0])).searchParams.get('token')).toBe('new-token');
  } finally { client.stop(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});
