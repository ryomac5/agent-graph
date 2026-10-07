import { store, type ScreenStore, type Snapshot } from './store.ts';

export interface Ack { type: 'ack'; cmd_id: string; ok: boolean; result?: unknown; error?: string }
interface Command { type: 'cmd'; cmd_id: string; command: string; payload?: unknown }
interface Socket {
  readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  send(data: string): void;
  close(): void;
}
export interface ClientOptions {
  url: string; token: string; store?: ScreenStore;
  createSocket?: (url: string) => Socket;
  fetchSnapshot?: () => Promise<Snapshot>;
}
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
export function createClient(options: ClientOptions) {
  const target = options.store ?? store;
  const url = new URL(options.url);
  url.searchParams.set('token', options.token);
  const snapshotUrl = new URL(url);
  snapshotUrl.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  snapshotUrl.pathname = '/snapshot';
  const loadSnapshot = options.fetchSnapshot ?? (async () => {
    const response = await fetch(snapshotUrl, { headers: { 'x-agent-graph-token': options.token } });
    if (!response.ok) throw new Error(`Snapshot: ${response.status}`);
    return response.json() as Promise<Snapshot>;
  });
  const pending = new Map<string, { message: Command; resolve: (ack: Ack) => void; reject: (error: Error) => void; promise: Promise<Ack> }>();
  let socket: Socket | undefined;
  let stopped = true;
  let retry = RECONNECT_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let syncing = false;
  let initialized = Object.keys(target.getSnapshot().projection).length > 0;
  let epoch = 0;
  function send(message: unknown) { if (!syncing && socket?.readyState === 1) socket.send(JSON.stringify(message)); }
  function hello() {
    const { seq, generation } = target.getSnapshot();
    send({ type: 'hello', seq, generation });
    for (const item of pending.values()) send(item.message);
  }
  async function resync() {
    if (syncing) return;
    syncing = true;
    const current = epoch;
    try {
      const snapshot = await loadSnapshot();
      if (stopped || current !== epoch) return;
      target.setSnapshot(snapshot);
      initialized = true;
      retry = RECONNECT_MIN_MS;
      syncing = false;
      hello();
    } catch {
      if (!stopped && current === epoch) socket?.close();
    } finally { if (current === epoch) syncing = false; }
  }
  function connect() {
    if (stopped) return;
    const current = ++epoch;
    syncing = false;
    const ws = (options.createSocket ?? (address => new WebSocket(address)))(url.href);
    socket = ws;
    ws.onopen = () => {
      if (stopped || current !== epoch) return;
      target.setConnection('connected');
      if (!initialized || pending.size > 0) void resync();
      else hello();
    };
    ws.onmessage = event => {
      if (stopped || current !== epoch) return;
      let message;
      try { message = JSON.parse(event.data); } catch { ws.close(); return; }
      if (!message || typeof message !== 'object') { ws.close(); return; }
      if (message.type === 'resync') { void resync(); return; }
      if (message.type === 'ack') {
        const item = pending.get(message.cmd_id);
        if (item) { pending.delete(message.cmd_id); item.resolve(message); }
        if (!message.ok && message.error === 'Runner unavailable') target.setConnection('runner_unavailable');
      } else if (message.type === 'runner') {
        target.setConnection(message.available ? 'connected' : 'runner_unavailable');
      } else if (!syncing && message.type === 'patch') {
        if (!target.applyPatch(message)) void resync();
        else retry = RECONNECT_MIN_MS;
      } else if (!syncing && message.type === 'delta') target.appendDelta(message);
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      if (stopped || current !== epoch) return;
      ++epoch;
      syncing = false;
      target.clearDeltas();
      target.setConnection('reconnecting');
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, RECONNECT_MAX_MS);
    };
  }
  return {
    start() { if (stopped) { stopped = false; target.setConnection('connecting'); connect(); } },
    stop() {
      stopped = true; ++epoch; clearTimeout(timer); socket?.close();
      for (const item of pending.values()) item.reject(new Error('Client stopped'));
      pending.clear();
    },
    command(command: string, payload?: unknown, cmd_id: string = crypto.randomUUID()): Promise<Ack> {
      const existing = pending.get(cmd_id);
      if (existing) return existing.promise;
      let resolve!: (ack: Ack) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<Ack>((done, fail) => { resolve = done; reject = fail; });
      const message: Command = { type: 'cmd', cmd_id, command, payload };
      pending.set(cmd_id, { message, resolve, reject, promise });
      send(message);
      return promise;
    },
  };
}
