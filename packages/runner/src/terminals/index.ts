import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { filterTerminalEnv, spawnTerminal } from "./spawn.ts";

export const MAX_TERMINALS = 8;
export const MAX_SCROLLBACK_BYTES = 256 * 1024;
const MAX_TERMINAL_DIMENSION = 65535;
const ALLOWED_FILES = new Set(["claude", "codex", "ssh"]);

export type TerminalProcess = Pick<IPty, "pid" | "write" | "resize" | "kill" | "onData" | "onExit">;
export type TerminalExit = { exitCode: number; signal?: number };
export interface TerminalSpawnRequest<Meta> {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
  meta: Meta;
}
export interface TerminalInfo<Meta> {
  terminalId: string;
  pid: number;
  meta: Meta;
  startedAt: string;
  scrollback: string;
  exited?: TerminalExit;
}
export interface TerminalRegistryOptions {
  openTerminal?: (file: string, args: string[], options: Parameters<typeof spawnTerminal>[2]) => TerminalProcess;
}

function validateSize(cols: number, rows: number): void {
  if (![cols, rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_DIMENSION))
    throw new Error("Invalid terminal size");
}

function createScrollback() {
  const buffer = Buffer.alloc(MAX_SCROLLBACK_BYTES);
  let offset = 0, length = 0;
  return {
    append(data: string) {
      const bytes = Buffer.from(data);
      const tail = bytes.subarray(Math.max(0, bytes.length - MAX_SCROLLBACK_BYTES));
      const first = Math.min(tail.length, MAX_SCROLLBACK_BYTES - offset);
      buffer.set(tail.subarray(0, first), offset);
      buffer.set(tail.subarray(first), 0);
      offset = (offset + tail.length) % MAX_SCROLLBACK_BYTES;
      length = Math.min(MAX_SCROLLBACK_BYTES, length + tail.length);
    },
    read(): string {
      const start = (offset - length + MAX_SCROLLBACK_BYTES) % MAX_SCROLLBACK_BYTES;
      const bytes = Buffer.concat([buffer.subarray(start, start + Math.min(length, MAX_SCROLLBACK_BYTES - start)),
        buffer.subarray(0, Math.max(0, length - (MAX_SCROLLBACK_BYTES - start)))]);
      // 切り捨て境界の UTF-8 継続バイトを除き、再接続時に置換文字を出さない。
      let skip = 0;
      while (skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip++;
      return bytes.toString("utf8", skip);
    },
  };
}

export function createTerminalRegistry<Meta = Record<string, unknown>>(options: TerminalRegistryOptions = {}) {
  type Entry = {
    info: Omit<TerminalInfo<Meta>, "scrollback">;
    terminal: TerminalProcess;
    scrollback: ReturnType<typeof createScrollback>;
    subscriptions: { dispose(): void }[];
  };
  const terminals = new Map<string, Entry>();
  const dataListeners = new Set<(event: { terminalId: string; data: string }) => void>();
  const exitListeners = new Set<(event: TerminalExit & { terminalId: string }) => void>();
  let disposed = false;

  function getTerminal(terminalId: string): Entry {
    const entry = terminals.get(terminalId);
    if (!entry) throw new Error("Unknown terminal");
    return entry;
  }
  function getLiveTerminal(terminalId: string): TerminalProcess {
    const entry = getTerminal(terminalId);
    if (entry.info.exited) throw new Error("Terminal has exited");
    return entry.terminal;
  }
  function removeTerminal(terminalId: string): void {
    const entry = getTerminal(terminalId);
    if (!entry.info.exited) entry.terminal.kill();
    for (const subscription of entry.subscriptions) subscription.dispose();
    terminals.delete(terminalId);
  }
  return {
    spawn(request: TerminalSpawnRequest<Meta>): { terminalId: string; pid: number } {
      if (disposed) throw new Error("Terminal registry disposed");
      if (!ALLOWED_FILES.has(request.file)) throw new Error("Invalid terminal executable");
      validateSize(request.cols, request.rows);
      if (terminals.size >= MAX_TERMINALS) throw new Error("Terminal limit reached");
      const meta = structuredClone(request.meta);
      const env = filterTerminalEnv(request.env);
      env.TERM ??= "xterm-256color";
      const terminal = (options.openTerminal ?? spawnTerminal)(request.file, [...request.args], {
        cwd: request.cwd, env, name: env.TERM, cols: request.cols, rows: request.rows,
      });
      const terminalId = randomUUID();
      const entry: Entry = { terminal, info: { terminalId, pid: terminal.pid, meta, startedAt: new Date().toISOString() },
        scrollback: createScrollback(), subscriptions: [] };
      terminals.set(terminalId, entry);
      entry.subscriptions.push(terminal.onData(data => {
        if (!terminals.has(terminalId) || entry.info.exited) return;
        entry.scrollback.append(data);
        for (const listener of dataListeners) listener({ terminalId, data });
      }));
      entry.subscriptions.push(terminal.onExit(exit => {
        if (!terminals.has(terminalId) || entry.info.exited) return;
        entry.info.exited = { ...exit };
        for (const listener of exitListeners) listener({ terminalId, ...exit });
      }));
      return { terminalId, pid: terminal.pid };
    },
    list(): TerminalInfo<Meta>[] {
      return [...terminals.values()].map(entry => ({ ...structuredClone(entry.info), scrollback: entry.scrollback.read() }));
    },
    write(terminalId: string, data: string): void {
      if (typeof data !== "string") throw new Error("Invalid terminal input");
      getLiveTerminal(terminalId).write(data);
    },
    resize(terminalId: string, cols: number, rows: number): void {
      validateSize(cols, rows);
      getLiveTerminal(terminalId).resize(cols, rows);
    },
    kill: removeTerminal,
    onData(listener: (event: { terminalId: string; data: string }) => void) {
      dataListeners.add(listener);
      return { dispose() { dataListeners.delete(listener); } };
    },
    onExit(listener: (event: TerminalExit & { terminalId: string }) => void) {
      exitListeners.add(listener);
      return { dispose() { exitListeners.delete(listener); } };
    },
    dispose(terminalId?: string): void {
      if (terminalId !== undefined) { removeTerminal(terminalId); return; }
      disposed = true;
      dataListeners.clear();
      exitListeners.clear();
      for (const id of terminals.keys()) removeTerminal(id);
    },
  };
}
