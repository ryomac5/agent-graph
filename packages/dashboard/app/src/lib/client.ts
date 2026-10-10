import { fetchProjection, type ConversationPageData } from './projection-client.ts';
import { store, type ScreenStore, type Snapshot } from './store.ts';

export interface Ack { type: 'ack'; cmd_id: string; ok: boolean; result?: unknown; error?: string }
export type TerminalNotice = { type: 'terminal'; event: 'output'; terminalId: string; data: string } | { type: 'terminal'; event: 'exit'; terminalId: string; exitCode: number };
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
  refreshToken?: () => Promise<string>;
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
    const response = await fetch(snapshotUrl, { headers: { 'x-agent-graph-token': url.searchParams.get('token') ?? '' } });
    if (!response.ok) throw new Error(`Snapshot: ${response.status}`);
    return response.json() as Promise<Snapshot>;
  });
  const terminalListeners = new Set<(notice: TerminalNotice) => void>();
  const connectedListeners = new Set<() => void>();
  const terminalIds = new Set<string>();
  const opened = new Map<string, number>();
  const pending = new Map<string, { message: Command; resolve: (ack: Ack) => void; reject: (error: Error) => void; promise: Promise<Ack> }>();
  let socket: Socket | undefined;
  let stopped = true;
  let retry = RECONNECT_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let syncing = false;
  let initialized = Object.keys(target.getSnapshot().projection).length > 0;
  let epoch = 0;
  // 画面の配信元が runner の状態を知らせる接続では、その知らせだけを信じる。
  let runnerReported = false;
  function send(message: unknown) { if (!syncing && socket?.readyState === 1) socket.send(JSON.stringify(message)); }
  function subscribe() {
    const { seq, generation } = target.getSnapshot();
    send({ type: 'hello', seq, generation, scope: { conversations: [...opened.keys()] } });
  }
  function hello() {
    subscribe();
    for (const item of pending.values()) send(item.message);
    for (const listener of connectedListeners) listener();
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
  async function connect() {
    if (stopped) return;
    const current = ++epoch;
    syncing = false;
    if (current > 1 && options.refreshToken) {
      try {
        const token = await options.refreshToken();
        if (stopped || current !== epoch) return;
        url.searchParams.set('token', token);
        snapshotUrl.searchParams.set('token', token);
      } catch {
        if (!stopped && current === epoch) {
          timer = setTimeout(connect, retry);
          retry = Math.min(retry * 2, RECONNECT_MAX_MS);
        }
        return;
      }
    }
    const ws = (options.createSocket ?? (address => new WebSocket(address)))(url.href);
    socket = ws;
    runnerReported = false;
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
      if (message.type === 'terminal' && typeof message.terminalId === 'string' && (message.event === 'output' && typeof message.data === 'string' || message.event === 'exit' && typeof message.exitCode === 'number')) {
        if (message.event === 'exit') terminalIds.delete(message.terminalId);
        for (const listener of terminalListeners) listener(message);
        return;
      }
      if (message.type === 'resync') { void resync(); return; }
      if (message.type === 'ack') {
        const item = pending.get(message.cmd_id);
        if (item) {
          if (item.message.command === 'terminal.open' && message.ok && typeof message.result?.terminalId === 'string') terminalIds.add(message.result.terminalId);
          pending.delete(message.cmd_id); item.resolve(message);
        }
        // 知らせの無い接続に限り、応答から runner の有無を推す。成功の応答が来たら戻す。
        if (!runnerReported) {
          const connection = target.getSnapshot().connection;
          if (!message.ok && message.error === 'Runner unavailable') target.setConnection('runner_unavailable');
          else if (message.ok && connection === 'runner_unavailable') target.setConnection('connected');
        }
      } else if (message.type === 'runner') {
        runnerReported = true;
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
      for (const terminalId of terminalIds) for (const listener of terminalListeners) listener({ type: 'terminal', event: 'exit', terminalId, exitCode: -1 });
      terminalIds.clear();
      for (const [id, item] of pending) if (item.message.command.startsWith('terminal.')) { pending.delete(id); item.resolve({ type: 'ack', cmd_id: id, ok: false, error: 'Terminal disconnected' }); }
      target.clearDeltas();
      target.setConnection('reconnecting');
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, RECONNECT_MAX_MS);
    };
  }
  return {
    subscribeConnected(listener: () => void) { connectedListeners.add(listener); return () => { connectedListeners.delete(listener); }; },
    subscribeTerminal(listener: (notice: TerminalNotice) => void) { terminalListeners.add(listener); return () => { terminalListeners.delete(listener); }; },
    start() { if (stopped) { stopped = false; target.setConnection('connecting'); connect(); } },
    stop() {
      stopped = true; ++epoch; clearTimeout(timer); socket?.close();
      for (const item of pending.values()) item.reject(new Error('Client stopped'));
      pending.clear();
    },
    watchConversation(id: string) {
      opened.set(id, (opened.get(id) ?? 0) + 1); subscribe();
      return () => { const count = (opened.get(id) ?? 1) - 1; if (count) opened.set(id, count); else opened.delete(id); subscribe(); };
    },
    fetchConversation(path: string, signal: AbortSignal) {
      return fetchProjection<ConversationPageData>(path, signal, snapshotUrl.origin, url.searchParams.get('token') ?? '');
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
