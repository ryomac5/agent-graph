import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../lib/client.ts';
import { createStore, type Snapshot } from '../lib/store.ts';

class FakeSocket {
  readyState = 0;
  onopen: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')); }
  receive(message: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) })); }
}
function fixture(fetchSnapshot: () => Promise<Snapshot> = vi.fn(async () => ({ seq: 20, generation: 2, projection: { tasks: [{ id: 'new' }] } }))) {
  const target = createStore();
  target.setSnapshot({ seq: 10, generation: 1, projection: { tasks: [{ id: 'old' }] } });
  const sockets: FakeSocket[] = [];
  const client = createClient({ url: 'ws://localhost/ws', token: 'secret', store: target, fetchSnapshot,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
  client.start(); sockets[0].open();
  return { target, sockets, client, fetchSnapshot };
}
afterEach(() => vi.useRealTimers());
describe('WebSocket client', () => {
  it('reconnects with the last seq and generation, applies replay once, and backs off', async () => {
    vi.useFakeTimers();
    const { client, sockets, target } = fixture();
    const patch = { type: 'patch', from_seq: 10, seq: 12, generation: 1,
      changes: { tasks: { upsert: [{ id: 'new' }], remove: ['old'] } } };
    sockets[0].receive(patch); sockets[0].receive(patch);
    expect(target.getSnapshot().projection.tasks).toEqual([{ id: 'new' }]);
    sockets[0].close(); expect(target.getSnapshot().connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(500); sockets[1].open();
    expect(sockets[1].sent[0]).toEqual({ type: 'hello', seq: 12, generation: 1 });
    sockets[1].close(); await vi.advanceTimersByTimeAsync(999); expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(3);
    client.stop();
  });
  it('resyncs through HTTP and subscribes with the snapshot generation', async () => {
    const { client, sockets, target, fetchSnapshot } = fixture();
    sockets[0].receive({ type: 'resync' }); sockets[0].receive({ type: 'resync' });
    await vi.waitFor(() => expect(target.getSnapshot().seq).toBe(20));
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(sockets[0].sent.at(-1)).toEqual({ type: 'hello', seq: 20, generation: 2 });
    client.stop();
  });
  it('retries an unacknowledged command with the same id and the receiver acts once', async () => {
    vi.useFakeTimers();
    const { client, sockets } = fixture();
    const received = new Map<string, unknown>();
    let effects = 0;
    const result = client.command('start', { task: 'one' }, 'cmd-1');
    expect(client.command('start', { task: 'one' }, 'cmd-1')).toBe(result);
    function accept(socket: FakeSocket, acknowledge: boolean) {
      const command = socket.sent.find(message => message.type === 'cmd')!;
      const id = String(command.cmd_id);
      if (!received.has(id)) { effects++; received.set(id, { effects }); }
      if (acknowledge) socket.receive({ type: 'ack', cmd_id: id, ok: true, result: received.get(id) });
    }
    accept(sockets[0], false); sockets[0].close();
    await vi.advanceTimersByTimeAsync(500); sockets[1].open(); await Promise.resolve(); accept(sockets[1], true);
    expect(await result).toEqual({ type: 'ack', cmd_id: 'cmd-1', ok: true, result: { effects: 1 } });
    expect(effects).toBe(1);
    sockets[1].close(); await vi.advanceTimersByTimeAsync(500); sockets[2].open();
    expect(sockets[2].sent.filter(message => message.type === 'cmd')).toHaveLength(0);
    client.stop();
  });
  it('groups deltas by message, clears them on completion and disconnection, exposes runner state', () => {
    const { client, sockets, target } = fixture();
    sockets[0].receive({ type: 'delta', runId: 'r', messageId: 'm', text: 'a' });
    sockets[0].receive({ type: 'delta', runId: 'r', messageId: 'm', text: 'b' });
    sockets[0].receive({ type: 'delta', runId: 'r', messageId: 'n', text: 'c' });
    expect(Object.values(target.getSnapshot().deltas).map(item => item.text)).toEqual(['ab', 'c']);
    sockets[0].receive({ type: 'patch', from_seq: 10, seq: 11, generation: 1,
      changes: { messages: { upsert: [{ id: 'm', body: 'ab' }], remove: [] } } });
    expect(Object.values(target.getSnapshot().deltas)).toHaveLength(1);
    sockets[0].receive({ type: 'runner', available: false }); expect(target.getSnapshot().connection).toBe('runner_unavailable');
    sockets[0].receive({ type: 'runner', available: true }); expect(target.getSnapshot().connection).toBe('connected');
    sockets[0].close(); expect(target.getSnapshot().deltas).toEqual({}); client.stop();
  });
  it('ignores a stale snapshot after disconnect', async () => {
    let complete!: (value: { seq: number; generation: number; projection: {} }) => void;
    const fetchSnapshot = vi.fn(() => new Promise<{ seq: number; generation: number; projection: {} }>(done => { complete = done; }));
    const { client, sockets, target } = fixture(fetchSnapshot);
    sockets[0].receive({ type: 'resync' }); sockets[0].close();
    complete({ seq: 99, generation: 3, projection: {} }); await Promise.resolve();
    expect(target.getSnapshot().seq).toBe(10); client.stop();
  });
});
it('loads the initial snapshot before hello and commands so existing rows are present', async () => {
  const target = createStore();
  const socket = new FakeSocket();
  const client = createClient({ url: 'ws://localhost/ws', token: 'secret', store: target,
    createSocket: () => socket, fetchSnapshot: async () => ({ seq: 7, generation: 0, projection: { tasks: [{ id: 'existing' }] } }) });
  client.start();
  const result = client.command('start', {}, 'initial');
  socket.open(); expect(socket.sent).toEqual([]);
  await Promise.resolve();
  expect(socket.sent[0]).toEqual({ type: 'hello', seq: 7, generation: 0 });
  expect(target.getSnapshot().projection.tasks).toEqual([{ id: 'existing' }]);
  socket.receive({ type: 'ack', cmd_id: 'initial', ok: true, result: {} });
  await result; client.stop();
});
it('replaces Claude deltas without message ids when the assistant message and membership arrive', () => {
  const target = createStore();
  target.appendDelta({ runId: 'run', conversationId: 'conversation', text: 'stream' });
  target.applyPatch({ type: 'patch', from_seq: 0, seq: 1, generation: 0, changes: {
    messages: { upsert: [{ id: 'm', role: 'assistant', body: 'complete' }], remove: [] },
    message_memberships: { upsert: [{ id: 'link', message_id: 'm', conversation_id: 'conversation', active: 1 }], remove: [] },
  } });
  expect(target.getSnapshot().deltas).toEqual({});
});
