import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type { JsonValue } from "../../../core/src/ledger/facts.ts";
import type { RunnerClient, RunnerEvent, RunnerResponse } from "../runner-client.ts";

const REATTACH_POLL_MS = 500;
const MAX_SCROLLBACK_BYTES = 256 * 1024;
const RESET_TERMINAL = "\x1bc";
type TerminalExit = { exitCode: number; signal?: number };
type TerminalEvent = Extract<RunnerEvent, { terminal: unknown }>["terminal"];
export type RunnerPtyClient = Pick<RunnerClient<RunnerEvent>, "request" | "available" | "connectionGeneration">;
export interface RunnerPtySpawnRequest {
  file: string; args: string[]; cwd: string; env: Record<string, string | undefined>;
  cols: number; rows: number; meta: Record<string, JsonValue>;
}
export interface RunnerTerminalInfo {
  terminalId: string; pid: number; meta: Record<string, JsonValue>;
  startedAt: string; scrollback: string; exited?: TerminalExit;
}
export type RunnerPty = Pick<IPty, "pid" | "write" | "resize" | "kill" | "onData" | "onExit"> & RunnerTerminalInfo;

function readScrollback(data: string): string {
  const bytes = Buffer.from(data);
  let start = Math.max(0, bytes.length - MAX_SCROLLBACK_BYTES);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.toString("utf8", start);
}

// RunnerClient のイベントコールバックから handleEvent を呼ぶ。close は購読だけを閉じる。
export function createRunnerPty(client: RunnerPtyClient, options: {
  onError?: (error: Error) => void;
} = {}) {
  type Entry = {
    info: RunnerTerminalInfo; pty: RunnerPty; attached: boolean;
    data: Set<(data: string) => void>; exit: Set<(exit: TerminalExit) => void>;
  };
  const entries = new Map<string, Entry>();
  let closed = false;
  let generation = client.connectionGeneration;
  let syncing: Promise<RunnerPty[]> | undefined;

  function sendRequest(command: string, payload?: JsonValue): Promise<RunnerResponse> {
    if (closed) return Promise.reject(new Error("Runner PTY adapter closed"));
    return client.request({ type: "req", cmd_id: randomUUID(), command, payload });
  }
  async function request(command: string, payload?: JsonValue): Promise<JsonValue> {
    const response = await sendRequest(command, payload);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }
  function report(error: unknown): void {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  function finish(entry: Entry, exit: TerminalExit): void {
    if (entry.info.exited) return;
    entry.info.exited = { ...exit };
    for (const listener of entry.exit) listener({ ...exit });
  }
  function attach(info: RunnerTerminalInfo): Entry {
    const existing = entries.get(info.terminalId);
    if (existing) return existing;
    const entry: Entry = { info: { ...info, exited: undefined }, attached: true,
      data: new Set(), exit: new Set(), pty: undefined! };
    function send(command: string, payload: Record<string, JsonValue> = {}): void {
      if (closed) throw new Error("Runner PTY adapter closed");
      if (!entry.attached) throw new Error("Unknown terminal");
      if (entry.info.exited && command !== "terminal.kill") throw new Error("Terminal has exited");
      // IPty の同期メソッドからの送信失敗は onError へ渡し、自動再送しない。
      void request(command, { ...payload, terminalId: info.terminalId }).then(() => {
        if (command === "terminal.kill") entry.attached = false;
      }).catch(report);
    }
    entry.pty = {
      get terminalId() { return info.terminalId; },
      get pid() { return entry.info.pid; },
      get meta() { return entry.info.meta; },
      get startedAt() { return entry.info.startedAt; },
      get scrollback() { return entry.info.scrollback; },
      get exited() { return entry.info.exited; },
      write(data) { send("terminal.write", { data: typeof data === "string" ? data : data.toString("utf8") }); },
      resize(cols, rows) { send("terminal.resize", { cols, rows }); },
      kill() { send("terminal.kill"); },
      onData(listener) {
        if (closed) throw new Error("Runner PTY adapter closed");
        entry.data.add(listener);
        if (entry.info.scrollback) listener(entry.info.scrollback);
        return { dispose() { entry.data.delete(listener); } };
      },
      onExit(listener) {
        if (closed) throw new Error("Runner PTY adapter closed");
        entry.exit.add(listener);
        if (entry.info.exited) listener({ ...entry.info.exited });
        return { dispose() { entry.exit.delete(listener); } };
      },
    };
    entries.set(info.terminalId, entry);
    return entry;
  }
  function list(): Promise<RunnerPty[]> {
    if (syncing) return syncing;
    const currentGeneration = client.connectionGeneration;
    syncing = sendRequest("terminal.list").then(response => {
      if (!response.ok) throw new Error(response.error);
      const result = response.result;
      if (closed) throw new Error("Runner PTY adapter closed");
      if (!client.available || currentGeneration !== client.connectionGeneration) throw new Error("Runner connection changed");
      if (!Array.isArray(result)) throw new Error("Invalid terminal list");
      const infos = result as unknown as RunnerTerminalInfo[];
      const ids = new Set(infos.map(info => info.terminalId));
      for (const entry of entries.values()) entry.attached = ids.has(entry.info.terminalId);
      const terminals = infos.map(info => {
        const existing = entries.get(info.terminalId);
        const entry = attach(info);
        const previousScrollback = entry.info.scrollback;
        const exited = entry.info.exited;
        entry.info = { ...info, scrollback: readScrollback(info.scrollback), exited };
        entry.attached = true;
        // 一覧は完全な snapshot。画面の既存内容に追記すると同じ出力が重複する。
        if (existing && (generation !== currentGeneration || previousScrollback !== entry.info.scrollback)) {
          for (const listener of entry.data) listener(RESET_TERMINAL + entry.info.scrollback);
        }
        if (info.exited) finish(entry, info.exited);
        return entry.pty;
      });
      generation = currentGeneration;
      return terminals;
    }).finally(() => { syncing = undefined; });
    return syncing;
  }
  async function refresh(): Promise<void> {
    if (!closed && client.available && client.connectionGeneration !== generation) await list();
  }
  const timer = setInterval(() => { void refresh().catch(report); }, REATTACH_POLL_MS);
  timer.unref();
  function dispatch(terminal: TerminalEvent): void {
    if (closed || client.connectionGeneration !== generation) return;
    const entry = entries.get(terminal.terminalId);
    if (!entry || !entry.attached || entry.info.exited) return;
    if ("output" in terminal) {
      entry.info.scrollback = readScrollback(entry.info.scrollback + terminal.output);
      for (const listener of entry.data) listener(terminal.output);
    } else finish(entry, terminal.exit);
  }
  return {
    async spawn(input: RunnerPtySpawnRequest): Promise<RunnerPty> {
      const env = Object.fromEntries(Object.entries(input.env).filter((pair): pair is [string, string] => pair[1] !== undefined));
      const result = await request("terminal.spawn", { ...input, env });
      const terminalId = (result as { terminalId: string }).terminalId;
      // spawn 進行中に始まった一覧には新しい端末がない場合がある。
      if (syncing) await syncing;
      const terminal = (await list()).find(terminal => terminal.terminalId === terminalId);
      if (!terminal) throw new Error("Spawned terminal missing from runner");
      return terminal;
    },
    list,
    refresh,
    handleEvent(event: RunnerEvent): void {
      if (closed || !("terminal" in event)) return;
      if (client.connectionGeneration !== generation) void refresh().catch(report);
      // 同じ受信バッチでも、一覧応答より後のイベントは snapshot 適用後に届ける。
      if (syncing) queueMicrotask(() => dispatch(event.terminal));
      else dispatch(event.terminal);
    },
    close(): void {
      closed = true;
      clearInterval(timer);
      for (const entry of entries.values()) { entry.data.clear(); entry.exit.clear(); }
      entries.clear();
    },
  };
}
